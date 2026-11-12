import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Must match the vector(N) columns created in the migrations. */
export const EMBEDDING_DIM = 1024;

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_BATCH_SIZE = 50;
const GEMINI_MAX_ATTEMPTS = 6;
// The free tier allows 100 texts a minute.  When the limit is hit the API says
// how long to wait.  Background indexing ("patient") waits and resumes; a live
// search does not keep the user waiting and fails fast instead (the caller
// then falls back to keyword search).
const MAX_PATIENT_WAIT_MS = 120_000;
const MAX_IMPATIENT_WAIT_MS = 2_500;
const QUERY_CACHE_SIZE = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Identifies the vector space; stored next to every embedding. */
export function getEmbeddingModelId() {
  return env.embeddingsProvider === 'gemini' ? `gemini:${env.geminiEmbeddingModel}` : 'local:hash-v1';
}

/**
 * Cosine similarity below which a long-term memory is considered unrelated.
 * The scale depends on the model, so the floor does too.
 */
export function getRelevanceFloor() {
  // Measured with gemini-embedding-2: a question scores about 0.72 against the
  // text that answers it and 0.58-0.62 against unrelated text.
  return env.embeddingsProvider === 'gemini' ? 0.62 : 0.08;
}

export class EmbeddingError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'EmbeddingError';
    this.status = status;
  }
}

function normalise(values) {
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  return norm === 0 ? values : values.map((value) => value / norm);
}

// ------------------------------------------------------------------ Gemini --
// gemini-embedding-2 is told what a text is for through a prefix in the text
// itself.  Documents and queries get different prefixes, which is what lets a
// short question land near the long passage that answers it.

const asDocument = ({ title, text }) => `title: ${title?.trim() || 'none'} | text: ${text}`;
const asQuery = (text) => `task: search result | query: ${text}`;

function backoffMs(attempt) {
  // 1s, 2s, 4s, 8s with jitter; the free tier allows only a few requests a minute.
  return Math.min(20_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 250;
}

/** Reads "retryDelay": "38s" from a quota error, in milliseconds. */
function retryDelayMs(detail) {
  const match = detail.match(/"retryDelay"\s*:\s*"([\d.]+)s"/) ?? detail.match(/retry in ([\d.]+)s/i);
  return match ? Math.ceil(Number.parseFloat(match[1]) * 1000) : null;
}

async function geminiRequest(texts, { patient }) {
  const model = env.geminiEmbeddingModel;
  const body = JSON.stringify({
    requests: texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      // The model's native size is 3072; it is trained so that a prefix of the
      // vector is still a good embedding, which keeps the index a third the size.
      outputDimensionality: EMBEDDING_DIM,
    })),
  });

  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${GEMINI_BASE_URL}/models/${model}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.geminiApiKey },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // Network failure or timeout: worth retrying.
      if (attempt >= GEMINI_MAX_ATTEMPTS) throw new EmbeddingError('Could not reach the embeddings service.', { cause: error });
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) {
      const payload = await response.json();
      const vectors = (payload.embeddings ?? []).map((item) => item.values);
      if (vectors.length !== texts.length || vectors.some((vector) => vector?.length !== EMBEDDING_DIM)) {
        throw new EmbeddingError(`The embeddings service returned an unexpected shape (wanted ${texts.length} × ${EMBEDDING_DIM}).`);
      }
      return vectors.map(normalise);
    }

    const detail = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    // Wait as long as the API asks; if a quota error does not say, assume the per-minute window.
    const waitMs =
      response.status === 429 ? (retryDelayMs(detail) ?? (patient ? 30_000 : backoffMs(attempt))) : backoffMs(attempt);
    const tooLongToWait = waitMs > (patient ? MAX_PATIENT_WAIT_MS : MAX_IMPATIENT_WAIT_MS);
    if (!retryable || tooLongToWait || attempt >= GEMINI_MAX_ATTEMPTS) {
      const keyProblem = response.status === 401 || response.status === 403 || /api key/i.test(detail);
      logger.warn(
        {
          status: response.status,
          quota: detail.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1],
          retryInMs: response.status === 429 ? retryDelayMs(detail) : undefined,
          attempt,
          detail: detail.replace(/\s+/g, ' ').slice(0, 200),
        },
        'gemini embeddings request failed',
      );
      throw new EmbeddingError(
        keyProblem
          ? 'Embeddings request failed (the Gemini API key was rejected).'
          : response.status === 429
            ? 'Embeddings request failed (the Gemini quota is used up for now).'
            : `Embeddings request failed (status ${response.status}).`,
        { status: response.status },
      );
    }

    if (response.status === 429 && waitMs > 5000) {
      logger.info(`embedding rate limit reached, resuming in ${Math.ceil(waitMs / 1000)}s`);
    }
    await sleep(waitMs + 500);
  }
}

async function geminiEmbed(texts, { patient = false } = {}) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += GEMINI_BATCH_SIZE) {
    vectors.push(...(await geminiRequest(texts.slice(start, start + GEMINI_BATCH_SIZE), { patient })));
  }
  return vectors;
}

// ------------------------------------------------------------------- local --
// Offline stand-in used for development without an API key and for tests.
// It hashes word and word-pair features into a fixed-size vector, so texts
// that share vocabulary end up close together.  It captures wording, not
// meaning: use Gemini for real semantic search.

const STOPWORDS = new Set(
  `a about after again all also am an and any are as at be because been before being both but by can did do does
   doing down during each few for from further had has have having he her here hers him his how i if in into is it
   its just me more most my no nor not now of off on once only or other our out over own same she so some such than
   that the their them then there these they this those through to too under until up very was we were what when
   where which while who whom why will with would you your`.split(/\s+/),
);

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);
}

function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function localEmbed(text) {
  const vector = new Float64Array(EMBEDDING_DIM);
  const tokens = tokenize(text);
  const add = (feature, weight) => {
    const hash = fnv1a(feature);
    const sign = hash & 0x80000000 ? -1 : 1;
    vector[hash % EMBEDDING_DIM] += sign * weight;
  };
  tokens.forEach((token, index) => {
    add(token, 1);
    if (index > 0) add(`${tokens[index - 1]}_${token}`, 0.5);
  });

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    // pgvector cannot take the cosine of a zero vector; use a fixed unit vector.
    vector[0] = 1;
    return Array.from(vector);
  }
  return Array.from(vector, (value) => Number((value / norm).toFixed(6)));
}

// ------------------------------------------------------------------ public --

const toDocument = (item) => (typeof item === 'string' ? { title: '', text: item } : item);

/**
 * Embeds texts that will be stored and searched over (journal chunks, memories).
 * Each item is a string or `{ title, text }`.  Indexing happens in the
 * background, so by default this waits out rate limits (`patient`).
 */
export async function embedDocuments(items, { patient = true } = {}) {
  if (items.length === 0) return [];
  const documents = items.map(toDocument);
  if (env.embeddingsProvider === 'gemini') return geminiEmbed(documents.map(asDocument), { patient });
  return documents.map((document) => localEmbed(document.text));
}

const queryCache = new Map();

/**
 * Embeds a search query.  Recent queries are cached to skip a network round
 * trip.  Someone is waiting for the result, so by default this does not wait
 * out a rate limit.
 */
export async function embedQuery(text, { patient = false } = {}) {
  const key = `${getEmbeddingModelId()}\n${text}`;
  const cached = queryCache.get(key);
  if (cached) {
    queryCache.delete(key);
    queryCache.set(key, cached);
    return cached;
  }

  const vector = env.embeddingsProvider === 'gemini' ? (await geminiEmbed([asQuery(text)], { patient }))[0] : localEmbed(text);

  queryCache.set(key, vector);
  if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value);
  return vector;
}
