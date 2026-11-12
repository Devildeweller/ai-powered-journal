/**
 * Retrieval benchmark for the vector search pipeline.
 *
 * Loads the 120-entry sample journal into a throwaway account, indexes it,
 * then asks 20 questions that each have exactly one correct entry and checks
 * where that entry lands in the results.
 *
 *   npm run eval:retrieval                against the configured database
 *   npm run eval:retrieval -- --memory    against a temporary in-memory database
 *
 * Reported per search mode (vector only, keyword only, hybrid):
 *   Recall@k  share of questions whose correct entry is in the top k
 *   MRR       mean reciprocal rank (1 = always first, 0.5 = second on average)
 *   latency   database search time, p50 and p95
 *
 * Quality numbers are only meaningful with real embeddings (GEMINI_API_KEY);
 * the offline "local" embedder matches wording, not meaning.
 */
import crypto from 'node:crypto';
import { EVAL_QUERIES, buildSampleJournal } from '../src/data/sampleJournal.js';
import { db, initDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { registerUser } from '../src/services/auth.js';
import { embedQuery, getEmbeddingModelId } from '../src/services/embeddings.js';
import { createEntry } from '../src/services/entries.js';
import { indexEntries } from '../src/services/indexer.js';
import { searchJournal } from '../src/services/retrieval.js';

const flags = new Set(process.argv.slice(2));
const TOP_K = 5;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const pct = (value) => `${(value * 100).toFixed(0)}%`.padStart(5);
const ms = (value) => `${value.toFixed(1)} ms`.padStart(9);

async function main() {
  await initDb({ inMemory: flags.has('--memory') });
  await migrate();

  const user = await registerUser({
    name: 'Retrieval Eval',
    email: `eval-${crypto.randomUUID()}@inkwell.test`,
    password: crypto.randomBytes(18).toString('base64url'),
  });

  try {
    const journal = buildSampleJournal();
    const idByKey = new Map();
    for (const item of journal) {
      const entry = await createEntry(
        user.id,
        { title: item.title, content: item.content, mood: item.mood, tags: item.tags, entryDate: item.date },
        { index: false, extractMemories: false },
      );
      idByKey.set(item.key, entry.id);
    }

    let started = performance.now();
    const chunkCount = await indexEntries([...idByKey.values()]);
    const indexSeconds = (performance.now() - started) / 1000;

    console.log('\nInkwell retrieval benchmark');
    console.log('---------------------------');
    console.log(`database    ${db.kind} (pgvector ${db.capabilities.vectorVersion})`);
    console.log(`embeddings  ${getEmbeddingModelId()}`);
    console.log(`dataset     ${journal.length} entries, ${chunkCount} chunks, ${EVAL_QUERIES.length} questions`);
    console.log(`indexing    ${indexSeconds.toFixed(1)} s (${(journal.length / indexSeconds).toFixed(0)} entries/s)\n`);

    // Embed every question once up front so search latency excludes the embedding API.
    const embedTimes = [];
    const embeddings = new Map();
    for (const { query } of EVAL_QUERIES) {
      started = performance.now();
      // The benchmark is a batch job, so it waits out free-tier rate limits.
      embeddings.set(query, await embedQuery(query, { patient: true }));
      embedTimes.push(performance.now() - started);
    }

    console.log('mode      R@1    R@3    R@5    MRR    search p50  search p95');
    const misses = [];
    for (const mode of ['vector', 'keyword', 'hybrid']) {
      const ranks = [];
      const latencies = [];
      for (const { key, query } of EVAL_QUERIES) {
        const { results, timings } = await searchJournal({
          userId: user.id,
          query,
          embedding: embeddings.get(query),
          limit: TOP_K,
          mode,
        });
        latencies.push(timings.searchMs);
        const rank = results.findIndex((result) => result.entryId === idByKey.get(key)) + 1;
        ranks.push(rank);
        if (mode === 'hybrid' && rank !== 1) misses.push({ query, rank, got: results[0]?.title ?? '(nothing)' });
      }
      const recallAt = (k) => ranks.filter((rank) => rank > 0 && rank <= k).length / ranks.length;
      const mrr = ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / ranks.length;
      console.log(
        `${mode.padEnd(8)} ${pct(recallAt(1))}  ${pct(recallAt(3))}  ${pct(recallAt(5))}  ${mrr.toFixed(3)}  ${ms(percentile(latencies, 50))}   ${ms(percentile(latencies, 95))}`,
      );
    }

    console.log(`\nquery embedding  p50 ${ms(percentile(embedTimes, 50)).trim()}, p95 ${ms(percentile(embedTimes, 95)).trim()}`);
    if (misses.length) {
      console.log('\nhybrid: questions where the correct entry was not ranked first');
      misses.forEach((miss) =>
        console.log(`  ${miss.rank ? `rank ${miss.rank}` : `not in top ${TOP_K}`.padEnd(6)}  "${miss.query}"  (top hit: ${miss.got})`),
      );
    }
    console.log('');
  } finally {
    // Cascades to the eval user's entries and chunks.
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
}

main()
  .catch((error) => {
    console.error(`Benchmark failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close().catch(() => {}));
