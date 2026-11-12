import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './index.js';
import { logger } from '../utils/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

/** Applies every .sql file in ./migrations that has not been applied yet, in name order. */
export async function migrate() {
  await initDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    // One transaction per file: a failing migration leaves no partial schema.
    await db.tx(async (transaction) => {
      await transaction.exec(sql);
      await transaction.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
    logger.info(`applied migration ${file}`);
  }

  await db.refreshCapabilities();
  return ran;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  migrate()
    .then(async (ran) => {
      logger.info(ran.length ? `done: ${ran.length} migration(s) applied` : 'database is up to date');
      await db.close();
    })
    .catch(async (error) => {
      logger.error({ err: error }, 'migration failed');
      await db.close().catch(() => {});
      process.exit(1);
    });
}
