import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load server/.env no matter which directory the process was started from.
// Variables already present in the environment (Render, tests) take precedence.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

/** Treat empty strings in .env ("KEY=") the same as an unset variable. */
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const flag = (defaultValue) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'])
      .default(defaultValue ? 'true' : 'false')
      .transform((value) => value === 'true'),
  );

const schema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'production']).default('development')),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4000)),
  CLIENT_ORIGIN: z.preprocess(emptyToUndefined, z.string().default('http://localhost:5173')),

  DATABASE_URL: optionalString,

  JWT_SECRET: optionalString,
  ACCESS_TOKEN_TTL: z.preprocess(emptyToUndefined, z.string().default('15m')),
  REFRESH_TOKEN_TTL_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(30)),
  COOKIE_SAMESITE: z.preprocess(emptyToUndefined, z.enum(['lax', 'strict', 'none']).default('lax')),

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.preprocess(emptyToUndefined, z.string().default('gemini-3.8-flash')),
  GEMINI_FALLBACK_MODELS: z.preprocess(emptyToUndefined, z.string().default('gemini-3.6-flash,gemini-3.5-flash-lite')),
  GEMINI_THINKING_LEVEL:z.preprocess(emptyToUndefined, z.enum(['minimal', 'low', 'medium', 'high']).default('low')),
  GEMINI_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().default('gemini-embedding-2')),
  EMBEDDINGS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['gemini', 'local']).optional()),

  MEMORY_EXTRACTION: flag(true),

  AWS_REGION: optionalString,
  S3_BUCKET: optionalString,

  SEED_EMAIL: z.preprocess(emptyToUndefined, z.string().default('demo@inkwell.test')),
  SEED_PASSWORD: z.preprocess(emptyToUndefined, z.string().default('inkwell-demo-2026')),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';
const isTest = raw.NODE_ENV === 'test';

if (isProduction) {
  const missing = [];
  if (!raw.DATABASE_URL) missing.push('DATABASE_URL');
  if (!raw.JWT_SECRET) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error(`Missing required environment variables in production: ${missing.join(', ')}`);
  }
}
if (raw.JWT_SECRET && raw.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long.');
}

// Outside production a missing secret is replaced by a per-boot random one.
// Access tokens then stop working on restart, and the client transparently
// refreshes them using the database-backed refresh token.
const jwtSecret = raw.JWT_SECRET ?? crypto.randomBytes(48).toString('base64url');

const embeddingsProvider = raw.EMBEDDINGS_PROVIDER ?? (raw.GEMINI_API_KEY ? 'gemini' : 'local');
if (embeddingsProvider === 'gemini' && !raw.GEMINI_API_KEY) {
  throw new Error('EMBEDDINGS_PROVIDER=gemini requires GEMINI_API_KEY.');
}

export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction,
  isTest,
  port: raw.PORT,
  clientOrigins: raw.CLIENT_ORIGIN.split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),

  databaseUrl: raw.DATABASE_URL,

  jwtSecret,
  jwtSecretIsEphemeral: !raw.JWT_SECRET,
  accessTokenTtl: raw.ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
  cookieSameSite: raw.COOKIE_SAMESITE,
  // SameSite=None is only accepted by browsers together with Secure.
  cookieSecure: isProduction || raw.COOKIE_SAMESITE === 'none',

  // One Gemini key powers chat, memory extraction and embeddings.
  geminiApiKey: raw.GEMINI_API_KEY,
  hasGeminiKey: Boolean(raw.GEMINI_API_KEY),
  geminiModel: raw.GEMINI_MODEL,
  // Tried in order: the preferred model, then the fallbacks when it is overloaded.
  geminiModels: [
    ...new Set([
      raw.GEMINI_MODEL,
      ...raw.GEMINI_FALLBACK_MODELS.split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ]),
  ],
  geminiThinkingLevel: raw.GEMINI_THINKING_LEVEL,
  geminiEmbeddingModel: raw.GEMINI_EMBEDDING_MODEL,
  embeddingsProvider,

  memoryExtraction: raw.MEMORY_EXTRACTION,

  awsRegion: raw.AWS_REGION,
  s3Bucket: raw.S3_BUCKET,

  seedEmail: raw.SEED_EMAIL,
  seedPassword: raw.SEED_PASSWORD,
});
