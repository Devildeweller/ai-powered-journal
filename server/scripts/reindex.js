/**
 * Re-embeds entries and memories.  Run it after changing the embedding
 * provider or model: vectors from different models are not comparable, so
 * searches ignore anything embedded by a model other than the active one.
 *
 *   npm run reindex            only what is stale, failed or still pending
 *   npm run reindex -- --all   everything
 */
import { db, toVector } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { embedDocuments, getEmbeddingModelId } from '../src/services/embeddings.js';
import { indexEntries } from '../src/services/indexer.js';

const all = process.argv.includes('--all');

async function main() {
  await migrate();
  const modelId = getEmbeddingModelId();

  const entries = await db.query(
    all
      ? 'SELECT id FROM entries ORDER BY created_at'
      : `SELECT e.id FROM entries e
         WHERE e.embedding_status <> 'ready'
            OR NOT EXISTS (SELECT 1 FROM entry_chunks c WHERE c.entry_id = e.id AND c.embedding_model = $1)
         ORDER BY e.created_at`,
    all ? [] : [modelId],
  );
  const ids = entries.rows.map((row) => row.id);
  console.log(`Re-indexing ${ids.length} entries with ${modelId}`);
  const chunks = await indexEntries(ids, {
    onProgress: (done, total) => process.stdout.write(`\r  entries ${done}/${total}`),
  });
  if (ids.length) console.log(`\n  ${chunks} chunks written`);

  const memories = await db.query(
    all ? 'SELECT id, content FROM memories' : 'SELECT id, content FROM memories WHERE embedding_model <> $1',
    all ? [] : [modelId],
  );
  console.log(`Re-embedding ${memories.rows.length} memories`);
  for (let start = 0; start < memories.rows.length; start += 64) {
    const batch = memories.rows.slice(start, start + 64);
    const vectors = await embedDocuments(batch.map((row) => row.content));
    for (let index = 0; index < batch.length; index += 1) {
      await db.query('UPDATE memories SET embedding = $2::vector, embedding_model = $3 WHERE id = $1', [
        batch[index].id,
        toVector(vectors[index]),
        modelId,
      ]);
    }
  }
  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(`\nRe-index failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close().catch(() => {}));
