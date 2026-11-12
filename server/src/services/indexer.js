import { db, toVector } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { buildChunkHeader, chunkText } from './chunker.js';
import { embedDocuments, getEmbeddingModelId } from './embeddings.js';
import { jobs } from './jobs.js';

const ENTRY_COLUMNS = `id, user_id, title, content, mood, tags,
  to_char(entry_date, 'YYYY-MM-DD') AS entry_date, content_hash`;

function prepare(entry) {
  const header = buildChunkHeader({
    entryDate: entry.entry_date,
    title: entry.title,
    tags: entry.tags,
    mood: entry.mood,
  });
  const chunks = chunkText(entry.content);
  return { entry, chunks, inputs: chunks.map((chunk) => ({ title: entry.title, text: `${header}\n\n${chunk}` })) };
}

/**
 * Replaces an entry's chunks atomically.  The content hash is re-checked under
 * a row lock: if the entry was edited while its text was being embedded, these
 * vectors are stale and a newer job is already queued, so nothing is written.
 */
async function storeChunks({ entry, chunks }, vectors, modelId) {
  return db.tx(async (transaction) => {
    const { rows } = await transaction.query('SELECT content_hash FROM entries WHERE id = $1 FOR UPDATE', [entry.id]);
    if (rows.length === 0 || rows[0].content_hash !== entry.content_hash) return false;

    await transaction.query('DELETE FROM entry_chunks WHERE entry_id = $1', [entry.id]);
    for (let index = 0; index < chunks.length; index += 1) {
      await transaction.query(
        `INSERT INTO entry_chunks (entry_id, user_id, chunk_index, content, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [entry.id, entry.user_id, index, chunks[index], toVector(vectors[index]), modelId],
      );
    }
    await transaction.query(
      `UPDATE entries SET embedding_status = 'ready', embedding_error = NULL, indexed_at = now() WHERE id = $1`,
      [entry.id],
    );
    return true;
  });
}

async function markFailed(entryId, contentHash, error) {
  await db.query(
    `UPDATE entries SET embedding_status = 'failed', embedding_error = $3
     WHERE id = $1 AND content_hash = $2`,
    [entryId, contentHash, String(error?.message ?? error).slice(0, 500)],
  );
}

/** Chunk, embed and store one entry.  Throws on failure so the job queue can retry. */
export async function indexEntry(entryId) {
  const { rows } = await db.query(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = $1`, [entryId]);
  const entry = rows[0];
  if (!entry) return;

  const prepared = prepare(entry);
  const vectors = await embedDocuments(prepared.inputs);
  await storeChunks(prepared, vectors, getEmbeddingModelId());
}

/** Queue an entry for indexing after the current request has been answered. */
export function enqueueIndex(entryId) {
  jobs.add(`index-entry:${entryId}`, async () => {
    try {
      await indexEntry(entryId);
    } catch (error) {
      // Record the failure so the UI can show it; the queue decides about retries.
      const { rows } = await db.query('SELECT content_hash FROM entries WHERE id = $1', [entryId]);
      if (rows[0]) await markFailed(entryId, rows[0].content_hash, error);
      throw error;
    }
  });
}

/**
 * Index many entries with as few embedding requests as possible (seeding,
 * re-indexing after a model change).  Returns the number of chunks written.
 */
export async function indexEntries(entryIds, { batchSize = 40, onProgress } = {}) {
  const modelId = getEmbeddingModelId();
  let chunkCount = 0;

  for (let start = 0; start < entryIds.length; start += batchSize) {
    const ids = entryIds.slice(start, start + batchSize);
    const { rows } = await db.query(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = ANY($1::uuid[])`, [ids]);
    const prepared = rows.map(prepare);
    const vectors = await embedDocuments(prepared.flatMap((item) => item.inputs));

    let offset = 0;
    for (const item of prepared) {
      const slice = vectors.slice(offset, offset + item.chunks.length);
      offset += item.chunks.length;
      if (await storeChunks(item, slice, modelId)) chunkCount += item.chunks.length;
    }
    onProgress?.(Math.min(start + batchSize, entryIds.length), entryIds.length);
  }
  return chunkCount;
}

/** On boot, pick up entries whose indexing never finished (crash, deploy, provider outage). */
export async function recoverPendingEntries() {
  const { rows } = await db.query(`SELECT id FROM entries WHERE embedding_status = 'pending' ORDER BY created_at LIMIT 500`);
  rows.forEach((row) => enqueueIndex(row.id));
  if (rows.length) logger.info(`re-queued ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} for indexing`);
  return rows.length;
}
