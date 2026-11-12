import crypto from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Image attachments on AWS S3.
 *
 * Files never pass through this server.  The browser asks for a presigned
 * URL, uploads straight to S3 with it, then tells the API it is done.  The
 * bucket stays private: images are shown through short-lived presigned GET
 * URLs generated per request.
 */

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTRY = 8;
const ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const VIEW_URL_TTL_SECONDS = 60 * 60;

let client;
function getClient() {
  // Credentials come from the standard AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
  client ??= new S3Client({ region: env.awsRegion });
  return client;
}

export function isStorageConfigured() {
  return Boolean(env.s3Bucket && env.awsRegion);
}

function assertConfigured() {
  if (!isStorageConfigured()) {
    throw ApiError.unavailable('File storage is not configured on this server.', { code: 'storage_not_configured' });
  }
}

const toAttachment = (row, url = null) => ({
  id: row.id,
  entryId: row.entry_id,
  fileName: row.file_name,
  contentType: row.content_type,
  sizeBytes: row.size_bytes,
  status: row.status,
  url,
  createdAt: row.created_at,
});

const ATTACHMENT_COLUMNS = 'id, entry_id, storage_key, file_name, content_type, size_bytes, status, created_at';

/** Step 1 of an upload: reserve a row and hand the browser a presigned PUT URL. */
export async function createUpload(userId, { entryId, fileName, contentType, sizeBytes }) {
  assertConfigured();
  const extension = ALLOWED_TYPES[contentType];
  if (!extension) throw ApiError.badRequest('Only JPEG, PNG, WebP and GIF images can be attached.');
  if (sizeBytes > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'Images can be at most 5 MB.');

  const owner = await db.query(
    `SELECT (SELECT count(*)::int FROM attachments WHERE entry_id = e.id) AS attachment_count
     FROM entries e WHERE e.id = $1 AND e.user_id = $2`,
    [entryId, userId],
  );
  if (owner.rows.length === 0) throw ApiError.notFound('Entry not found.');
  if (owner.rows[0].attachment_count >= MAX_ATTACHMENTS_PER_ENTRY) {
    throw ApiError.badRequest(`An entry can have at most ${MAX_ATTACHMENTS_PER_ENTRY} images.`);
  }

  // The key is generated here, never taken from the client, and namespaced by user.
  const storageKey = `users/${userId}/entries/${entryId}/${crypto.randomUUID()}.${extension}`;
  const { rows } = await db.query(
    `INSERT INTO attachments (user_id, entry_id, storage_key, file_name, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ATTACHMENT_COLUMNS}`,
    [userId, entryId, storageKey, fileName, contentType, sizeBytes],
  );

  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({ Bucket: env.s3Bucket, Key: storageKey, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );
  return { attachment: toAttachment(rows[0]), uploadUrl, headers: { 'Content-Type': contentType } };
}

/**
 * Step 2: the browser reports the upload finished.  The object is checked in
 * S3 before the row is trusted, because a presigned PUT cannot enforce size.
 */
export async function completeUpload(userId, attachmentId) {
  assertConfigured();
  const { rows } = await db.query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = $1 AND user_id = $2`, [
    attachmentId,
    userId,
  ]);
  const attachment = rows[0];
  if (!attachment) throw ApiError.notFound('Attachment not found.');

  let head;
  try {
    head = await getClient().send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: attachment.storage_key }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
      throw ApiError.badRequest('The file has not been uploaded yet.');
    }
    throw error;
  }

  if ((head.ContentLength ?? 0) > MAX_ATTACHMENT_BYTES) {
    await removeObjects([attachment.storage_key]);
    await db.query('DELETE FROM attachments WHERE id = $1', [attachmentId]);
    throw new ApiError(413, 'Images can be at most 5 MB.');
  }

  const updated = await db.query(
    `UPDATE attachments SET status = 'ready', size_bytes = $2 WHERE id = $1 RETURNING ${ATTACHMENT_COLUMNS}`,
    [attachmentId, head.ContentLength ?? attachment.size_bytes],
  );
  return toAttachment(updated.rows[0], await viewUrl(attachment.storage_key));
}

function viewUrl(storageKey) {
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: env.s3Bucket, Key: storageKey }), {
    expiresIn: VIEW_URL_TTL_SECONDS,
  });
}

export async function listAttachments(userId, entryId) {
  if (!isStorageConfigured()) return [];
  const { rows } = await db.query(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
     WHERE entry_id = $1 AND user_id = $2 AND status = 'ready' ORDER BY created_at`,
    [entryId, userId],
  );
  return Promise.all(rows.map(async (row) => toAttachment(row, await viewUrl(row.storage_key))));
}

export async function deleteAttachment(userId, attachmentId) {
  const { rows } = await db.query('DELETE FROM attachments WHERE id = $1 AND user_id = $2 RETURNING storage_key', [
    attachmentId,
    userId,
  ]);
  if (rows.length === 0) return false;
  await removeObjects([rows[0].storage_key]);
  return true;
}

/** Best-effort object cleanup: a failure is logged, never surfaced to the user. */
export async function removeObjects(storageKeys) {
  if (!isStorageConfigured() || storageKeys.length === 0) return;
  try {
    if (storageKeys.length === 1) {
      await getClient().send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: storageKeys[0] }));
      return;
    }
    for (let start = 0; start < storageKeys.length; start += 1000) {
      await getClient().send(
        new DeleteObjectsCommand({
          Bucket: env.s3Bucket,
          Delete: { Objects: storageKeys.slice(start, start + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  } catch (error) {
    logger.warn({ err: error, count: storageKeys.length }, 'could not delete objects from S3');
  }
}
