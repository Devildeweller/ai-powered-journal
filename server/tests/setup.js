// Imported first by every test file, before any application module.
//
// Tests must never touch a real database or a paid API, whatever .env says.
// dotenv does not override variables that are already set, so these win:
// an empty DATABASE_URL selects the in-memory PGlite database, and the local
// embedder replaces Gemini embeddings.  The model itself is replaced per test (see
// fakeLlm in helpers.js).
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
  EMBEDDINGS_PROVIDER: 'local',
  GEMINI_API_KEY: '',
  S3_BUCKET: '',
  MEMORY_EXTRACTION: 'true',
});
