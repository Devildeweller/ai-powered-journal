import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Thin database access layer.
 *
 * Production and normal development talk to PostgreSQL through `pg`.  When no
 * DATABASE_URL is configured (local development, tests) the same SQL runs on
 * PGlite — PostgreSQL compiled to WebAssembly, including the pgvector
 * extension — so the vector search code paths are identical in both setups.
 *
 * Both drivers expose:
 *   query(text, params) -> { rows }
 *   exec(sql)           -> run a multi-statement script (migrations)
 *   tx(fn)              -> run fn({ query, exec }) inside one transaction
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const PGLITE_DATA_DIR = path.resolve(here, '../../.data/pglite');

let driver = null;
let capabilities = { vectorVersion: null, iterativeScan: false };

async function createPgDriver(connectionString) {
  const { default: pg } = await import('pg');
  // COUNT(*) and friends come back as int8; all our counts fit in a JS number.
  pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Idle clients can be dropped by the server (Neon suspends on inactivity);
  // without a listener that would crash the process.
  pool.on('error', (error) => logger.warn({ err: error }, 'idle postgres client error'));

  return {
    kind: 'postgres',
    query: (text, params) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (text, params) => client.query(text, params),
          exec: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createPgliteDriver({ inMemory }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');

  if (!inMemory) await fs.mkdir(PGLITE_DATA_DIR, { recursive: true });
  const pglite = new PGlite({ dataDir: inMemory ? 'memory://' : PGLITE_DATA_DIR, extensions: { vector } });
  await pglite.waitReady;

  const wrap = (runner) => ({
    query: async (text, params) => {
      const result = await runner.query(text, params);
      return { rows: result.rows };
    },
    exec: (sql) => runner.exec(sql),
  });

  return {
    kind: 'pglite',
    ...wrap(pglite),
    tx: (fn) => pglite.transaction((transaction) => fn(wrap(transaction))),
    close: () => pglite.close(),
  };
}

async function detectCapabilities() {
  const { rows } = await driver.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const version = rows[0]?.extversion ?? null;
  const [major = 0, minor = 0] = (version ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  capabilities = {
    vectorVersion: version,
    // pgvector 0.8 added iterative index scans, which keep filtered
    // (per-user) approximate searches from returning too few rows.
    iterativeScan: major > 0 || minor >= 8,
  };
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.inMemory]  force a throwaway in-memory database
 *                                      (tests, the retrieval benchmark)
 */
export async function initDb({ inMemory = env.isTest } = {}) {
  if (driver) return db;

  if (inMemory) {
    driver = await createPgliteDriver({ inMemory: true });
  } else if (env.databaseUrl) {
    driver = await createPgDriver(env.databaseUrl);
  } else {
    if (env.isProduction) throw new Error('DATABASE_URL is required in production.');
    driver = await createPgliteDriver({ inMemory: false });
    {
      logger.warn(`DATABASE_URL is not set: using embedded PGlite at ${PGLITE_DATA_DIR} (development only).`);
    }
  }
  return db;
}

function requireDriver() {
  if (!driver) throw new Error('Database not initialised: call initDb() first.');
  return driver;
}

export const db = {
  get kind() {
    return requireDriver().kind;
  },
  get capabilities() {
    return capabilities;
  },
  query: (text, params) => requireDriver().query(text, params),
  exec: (sql) => requireDriver().exec(sql),
  tx: (fn) => requireDriver().tx(fn),

  /**
   * Transaction tuned for approximate nearest-neighbour queries.
   * `SET LOCAL` only lasts until the transaction ends, so the settings never
   * leak onto other pooled connections.
   */
  vectorTx(fn) {
    return requireDriver().tx(async (transaction) => {
      await transaction.exec('SET LOCAL hnsw.ef_search = 100');
      if (capabilities.iterativeScan) {
        await transaction.exec("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      }
      return fn(transaction);
    });
  },

  async refreshCapabilities() {
    await detectCapabilities();
    return capabilities;
  },

  async close() {
    if (!driver) return;
    const current = driver;
    driver = null;
    await current.close();
  },
};

/** pgvector accepts vectors as the text literal "[1,2,3]". */
export function toVector(values) {
  return `[${Array.from(values).join(',')}]`;
}
