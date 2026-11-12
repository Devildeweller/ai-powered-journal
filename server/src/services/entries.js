import { db } from '../db/index.js';
import { ApiError } from '../utils/ApiError.js';
import { sha256 } from '../utils/tokens.js';
import { enqueueIndex } from './indexer.js';
import { enqueueEntryExtraction } from './memory.js';

const ENTRY_COLUMNS = `id, title, mood, tags, to_char(entry_date, 'YYYY-MM-DD') AS entry_date,
  word_count, embedding_status, embedding_error, created_at, updated_at`;

const toEntry = (row) => ({
  id: row.id,
  title: row.title,
  ...(row.content !== undefined ? { content: row.content } : {}),
  ...(row.excerpt !== undefined ? { excerpt: row.excerpt } : {}),
  mood: row.mood,
  tags: row.tags,
  entryDate: row.entry_date,
  wordCount: row.word_count,
  embeddingStatus: row.embedding_status,
  embeddingError: row.embedding_error ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const countWords = (text) => (text.match(/\S+/g) ?? []).length;

/** Everything that feeds the embedding; if this is unchanged, no re-index is needed. */
function contentHash({ title, content, entryDate, tags, mood }) {
  return sha256([title, entryDate, tags.join(','), mood ?? '', content].join('\n'));
}

// The list is paged by keyset ("everything older than the last row you saw"),
// which stays fast at any depth, unlike OFFSET which rescans skipped rows.
const encodeCursor = (row) => Buffer.from(JSON.stringify([row.entry_date, row.id])).toString('base64url');

function decodeCursor(cursor) {
  try {
    const [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof date !== 'string' || typeof id !== 'string') throw new Error('bad cursor');
    return { date, id };
  } catch {
    throw ApiError.badRequest('Invalid cursor.');
  }
}

export async function listEntries(userId, { q, tag, mood, from, to, cursor, limit = 20 }) {
  const params = [userId];
  const where = ['user_id = $1'];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (q) {
    // Full-text match for whole words, plus a substring match so partial
    // words ("inter" -> "interview") still find something while typing.
    const term = add(q);
    const like = add(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(search @@ websearch_to_tsquery('english', ${term}) OR title ILIKE ${like} OR content ILIKE ${like})`);
  }
  if (tag) where.push(`tags @> ARRAY[${add(tag)}]::text[]`);
  if (mood) where.push(`mood = ${add(mood)}`);
  if (from) where.push(`entry_date >= ${add(from)}::date`);
  if (to) where.push(`entry_date <= ${add(to)}::date`);
  if (cursor) {
    const { date, id } = decodeCursor(cursor);
    where.push(`(entry_date, id) < (${add(date)}::date, ${add(id)}::uuid)`);
  }

  const { rows } = await db.query(
    `SELECT ${ENTRY_COLUMNS}, left(content, 280) AS excerpt
     FROM entries
     WHERE ${where.join(' AND ')}
     ORDER BY entry_date DESC, id DESC
     LIMIT ${add(limit + 1)}`,
    params,
  );

  const page = rows.slice(0, limit);
  return {
    entries: page.map(toEntry),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function getEntry(userId, entryId) {
  const { rows } = await db.query(`SELECT ${ENTRY_COLUMNS}, content FROM entries WHERE id = $1 AND user_id = $2`, [
    entryId,
    userId,
  ]);
  return rows[0] ? toEntry(rows[0]) : null;
}

export async function createEntry(
  userId,
  { title, content, mood, tags, entryDate },
  // Bulk imports index in batches themselves and skip per-entry memory extraction.
  { index = true, extractMemories = true } = {},
) {
  const { rows } = await db.query(
    `INSERT INTO entries (user_id, title, content, mood, tags, entry_date, word_count, content_hash)
     VALUES ($1, $2, $3, $4, $5::text[], $6::date, $7, $8)
     RETURNING ${ENTRY_COLUMNS}, content`,
    [userId, title, content, mood, tags, entryDate, countWords(content), contentHash({ title, content, entryDate, tags, mood })],
  );
  const entry = toEntry(rows[0]);
  if (index) enqueueIndex(entry.id);
  if (extractMemories) enqueueEntryExtraction({ userId, entry });
  return entry;
}

export async function updateEntry(userId, entryId, patch) {
  const current = await db.query(
    `SELECT title, content, mood, tags, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, content_hash
     FROM entries WHERE id = $1 AND user_id = $2`,
    [entryId, userId],
  );
  const existing = current.rows[0];
  if (!existing) return null;

  const next = {
    title: patch.title ?? existing.title,
    content: patch.content ?? existing.content,
    mood: patch.mood === undefined ? existing.mood : patch.mood,
    tags: patch.tags ?? existing.tags,
    entryDate: patch.entryDate ?? existing.entry_date,
  };
  const hash = contentHash(next);
  const changed = hash !== existing.content_hash;

  const { rows } = await db.query(
    `UPDATE entries SET
       title = $3, content = $4, mood = $5, tags = $6::text[], entry_date = $7::date,
       word_count = $8, content_hash = $9,
       embedding_status = CASE WHEN $10 THEN 'pending' ELSE embedding_status END,
       embedding_error = CASE WHEN $10 THEN NULL ELSE embedding_error END,
       updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING ${ENTRY_COLUMNS}, content`,
    [entryId, userId, next.title, next.content, next.mood, next.tags, next.entryDate, countWords(next.content), hash, changed],
  );
  const entry = toEntry(rows[0]);
  if (changed) {
    enqueueIndex(entry.id);
    // Only re-run memory extraction when the writing itself changed, not for a retag.
    if (next.content !== existing.content) enqueueEntryExtraction({ userId, entry });
  }
  return entry;
}

/** Deletes an entry (chunks and attachment rows cascade) and returns the S3 keys to clean up. */
export async function deleteEntry(userId, entryId) {
  const attachments = await db.query('SELECT storage_key FROM attachments WHERE entry_id = $1 AND user_id = $2', [
    entryId,
    userId,
  ]);
  const { rows } = await db.query('DELETE FROM entries WHERE id = $1 AND user_id = $2 RETURNING id', [entryId, userId]);
  if (rows.length === 0) return null;
  return { storageKeys: attachments.rows.map((row) => row.storage_key) };
}

export async function retryIndexing(userId, entryId) {
  const { rows } = await db.query(
    `UPDATE entries SET embedding_status = 'pending', embedding_error = NULL
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [entryId, userId],
  );
  if (rows.length === 0) return false;
  enqueueIndex(entryId);
  return true;
}

export async function listTags(userId) {
  const { rows } = await db.query(
    `SELECT tag, count(*)::int AS count
     FROM entries, unnest(tags) AS tag
     WHERE user_id = $1
     GROUP BY tag
     ORDER BY count DESC, tag
     LIMIT 100`,
    [userId],
  );
  return rows;
}
