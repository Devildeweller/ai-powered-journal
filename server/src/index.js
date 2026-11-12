import { createApp } from './app.js';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { getEmbeddingModelId } from './services/embeddings.js';
import { recoverPendingEntries } from './services/indexer.js';
import { jobs } from './services/jobs.js';
import { logger } from './utils/logger.js';

async function main() {
  // Migrations run on boot so a fresh deploy needs no manual database step.
  await migrate();

  if (env.jwtSecretIsEphemeral) {
    logger.warn('JWT_SECRET is not set: using a temporary secret (development only).');
  }
  if (!env.hasGeminiKey) {
    logger.warn('GEMINI_API_KEY is not set: the chat assistant is unavailable and search uses the offline keyword embedder.');
  } else if (env.embeddingsProvider === 'local') {
    logger.warn('EMBEDDINGS_PROVIDER=local: using the offline keyword-hashing embedder, not real semantic search.');
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(
      `Inkwell API listening on :${env.port} (${env.nodeEnv}, db=${db.kind}, pgvector=${db.capabilities.vectorVersion}, embeddings=${getEmbeddingModelId()})`,
    );
  });

  await recoverPendingEntries();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    // Stop accepting connections, give background jobs a moment, then close the pool.
    server.close();
    server.closeIdleConnections?.();
    await Promise.race([jobs.drain(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
