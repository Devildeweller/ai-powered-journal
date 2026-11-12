/**
 * Seeds a demo account with the 120-entry sample journal and indexes it.
 *
 *   npm run seed                 create the demo user and its journal
 *   npm run seed -- --reset      wipe the demo user's journal first
 *   npm run seed -- --recent     shift the dates so the journal ends today
 *
 * The demo credentials are SEED_EMAIL / SEED_PASSWORD from .env.
 */
import { env } from '../src/config/env.js';
import { buildSampleJournal } from '../src/data/sampleJournal.js';
import { db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { registerUser } from '../src/services/auth.js';
import { getEmbeddingModelId } from '../src/services/embeddings.js';
import { createEntry } from '../src/services/entries.js';
import { indexEntries } from '../src/services/indexer.js';
import { addDays, diffDays, todayIso } from '../src/utils/temporal.js';

const flags = new Set(process.argv.slice(2));

async function main() {
  if (env.isProduction && !flags.has('--force')) {
    throw new Error('Refusing to seed a production database. Pass --force if you really mean it.');
  }
  await migrate();

  const existing = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [env.seedEmail]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    userId = (await registerUser({ name: 'Demo Writer', email: env.seedEmail, password: env.seedPassword })).id;
    console.log(`Created demo user ${env.seedEmail}`);
  }

  const { rows } = await db.query('SELECT count(*)::int AS count FROM entries WHERE user_id = $1', [userId]);
  if (rows[0].count > 0) {
    if (!flags.has('--reset')) {
      console.log(`${env.seedEmail} already has ${rows[0].count} entries. Run with --reset to replace them.`);
      return;
    }
    await db.query('DELETE FROM entries WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM memories WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
    console.log(`Removed ${rows[0].count} existing entries.`);
  }

  const journal = buildSampleJournal();
  const shift = flags.has('--recent') ? diffDays(todayIso(), journal.at(-1).date) : 0;

  const ids = [];
  for (const item of journal) {
    const entry = await createEntry(
      userId,
      { title: item.title, content: item.content, mood: item.mood, tags: item.tags, entryDate: addDays(item.date, shift) },
      { index: false, extractMemories: false },
    );
    ids.push(entry.id);
  }
  console.log(`Inserted ${ids.length} entries (${addDays(journal[0].date, shift)} to ${addDays(journal.at(-1).date, shift)}).`);

  const started = performance.now();
  const chunks = await indexEntries(ids, {
    onProgress: (done, total) => process.stdout.write(`\rEmbedding with ${getEmbeddingModelId()}: ${done}/${total}`),
  });
  console.log(`\nIndexed ${chunks} chunks in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
  console.log(`\nSign in as ${env.seedEmail} with the SEED_PASSWORD from your .env (see .env.example for the default).`);
}

main()
  .catch((error) => {
    console.error(`\nSeeding failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close().catch(() => {}));
