# Inkwell: AI-Powered Journal Assistant

A private journal with an AI companion that answers questions from what you actually wrote (RAG) and remembers durable facts about you across conversations (long-term memory).

**Stack:** Node.js, Express 5, PostgreSQL + pgvector, JWT auth, Google Gemini (chat and embeddings), AWS S3 (photo attachments), React 19 + Vite + Tailwind CSS. Deploys to Render (API) and Vercel (web).

## How it works

```
question â”€â–º date-range detection â”€â–º query embedding (Gemini)
         â”€â–º hybrid search: pgvector cosine (HNSW) + Postgres full-text, fused with Reciprocal Rank Fusion
         â”€â–º long-term memory recall (similarity Ã— importance Ã— recency)
         â”€â–º context block â”€â–º Gemini â”€â–º answer streamed over SSE, with [n] citations linking to entries
         â”€â–º afterwards: the model distils new memories (add / update / delete) in the background
```

- **Indexing:** each entry is split into ~180-word overlapping chunks, each embedded with a header (date, title, tags) and stored in a `vector(1024)` column. Runs in a background queue; unfinished work is recovered on boot.
- **Auth:** 15-minute JWT access token held in memory; opaque refresh token in an httpOnly cookie, rotated on every use with reuse detection. Passwords hashed with bcrypt.
- **Attachments:** browser uploads straight to S3 with a presigned URL; the bucket stays private.

## Run locally

Requires Node.js 20+.

```bash
npm run install:all
```

```bash
cp server/.env.example server/.env
```

Fill in `server/.env`:

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Postgres with pgvector (e.g. a free Neon project). Leave empty to use an embedded dev database. |
| `JWT_SECRET` | Any random string of 32+ characters. |
| `GEMINI_API_KEY` | The chat assistant, memory extraction and real semantic search. Free key from https://aistudio.google.com/apikey. Without it, chat is off and search uses an offline keyword embedder. |
| `S3_BUCKET`, `AWS_*` | Photo attachments (optional). |

Then, in two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

Open http://localhost:5173. To load the 120-entry demo journal (sign in with `SEED_EMAIL` / `SEED_PASSWORD` from `.env`):

```bash
npm run seed -- --recent
```

After changing the embedding provider or model, re-embed everything with `npm run reindex --prefix server`.

**Free-tier limits:** Gemini allows 100 embedding texts per minute on the free tier, so seeding and re-indexing pause and resume automatically (about a minute for the demo journal). The chat model falls back along `GEMINI_MODEL` then `GEMINI_FALLBACK_MODELS` when a model is overloaded or out of quota.

**Privacy note:** on Gemini's free tier, Google may use submitted content to improve its products. The app sends `store: false` so interactions are not retained for later retrieval, but use a paid key before running real private journals through it.

## Tests and benchmark

```bash
npm test
```

83 tests (Node's built-in runner) covering auth and token rotation, journal CRUD, tenant isolation, vector search, the chat pipeline and memory. They run against an in-memory Postgres (PGlite, with real pgvector) and a fake model, so they need no keys.

```bash
npm run eval:retrieval -- --memory
```

Indexes the 120-entry sample journal and runs 25 queries that each have one correct entry (20 paraphrased questions, 5 exact-term lookups), reporting Recall@1/3/5, MRR and search latency for vector-only, keyword-only and hybrid search.

Measured on 2026-11-12 with `gemini-embedding-2` (1024 dimensions) on the embedded dev database:

| Mode | Recall@1 | Recall@5 | MRR | Search p50 |
|---|---|---|---|---|
| Vector only | 100% | 100% | 1.000 | 4.6 ms |
| Keyword only | 24% | 24% | 0.240 | 3.0 ms |
| Hybrid | 100% | 100% | 1.000 | 7.0 ms |

Search time excludes embedding the query (about 550 ms through the Gemini API). The dataset is small and its questions have unambiguous answers, so treat this as a regression check, not a general quality claim. Without `GEMINI_API_KEY` the script runs on the offline embedder and the numbers are much lower.

## Deploy

1. **Database:** create a Postgres database with pgvector (Neon or Render). Migrations run automatically on boot.
2. **API on Render:** create a Blueprint from `render.yaml` and set the secret environment variables it lists.
3. **Web on Vercel:** import the repo with root directory `client`. In `client/vercel.json`, replace the placeholder host with your Render URL. The rewrite proxies `/api` so the refresh cookie stays first-party.
4. **S3 (optional):** create a private bucket and allow `PUT`/`GET` from your Vercel origin in its CORS configuration.

## Project layout

```
server/src/routes      HTTP layer and validation (zod)
server/src/services    auth, entries, chunker, embeddings, indexer, retrieval, memory, chat, llm, storage
server/src/db          driver, migrations (SQL)
server/scripts         seed, reindex, retrieval benchmark
server/tests           unit and integration tests
client/src             React app (pages, components, API client)
```
