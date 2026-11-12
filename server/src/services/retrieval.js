import { db, toVector } from '../db/index.js';
import { embedQuery, getEmbeddingModelId, tokenize } from './embeddings.js';

/**
 * Hybrid retrieval over a user's journal.
 *
 *   1. Vector search  — cosine distance between the question embedding and
 *      every chunk embedding (pgvector `<=>`, HNSW index).  Finds entries that
 *      mean the same thing even when they share no words with the question.
 *   2. Keyword search — PostgreSQL full-text search over the same chunks,
 *      weighted by how rare each matching term is.  Catches exact names,
 *      places and rare words that embeddings blur.
 *   3. Reciprocal Rank Fusion merges the two ranked lists without having to
 *      compare cosine similarities with ts_rank scores (different scales).
 *   4. Chunks are grouped back into entries, best first.
 */

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: score(id) = Σ 1 / (k + rank) over every list the id
 * appears in.  Items ranked well by several retrievers rise to the top.
 */
export function reciprocalRankFusion(rankedLists, { k = RRF_K } = {}) {
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}

/** The distinct, non-stopword terms of a question, used for keyword matching. */
export function keywordTerms(text) {
  const terms = [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 1))];
  return terms.filter((term) => tokenize(term).length > 0).slice(0, 16);
}

/** The same terms as an OR query for to_tsquery ("interview | nervous | google"). */
export function buildKeywordQuery(text) {
  return keywordTerms(text).join(' | ');
}

/**
 * A keyword hit only counts if the chunk covers at least this share of the
 * question's term weight.  Without the gate, a chunk that merely shares a
 * common word ("work", "home") would enter the fusion and, because rank
 * fusion ignores how weak a match is, push better semantic matches down.
 */
const MIN_KEYWORD_COVERAGE = 0.5;

const CHUNK_SELECT = `
  c.id AS chunk_id, c.entry_id, c.chunk_index, c.content,
  e.title, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.mood, e.tags`;

const DATE_FILTER = `
  AND ($2::date IS NULL OR e.entry_date >= $2::date)
  AND ($3::date IS NULL OR e.entry_date <= $3::date)`;

async function vectorCandidates({ userId, embedding, from, to, limit }) {
  return db.vectorTx(async (transaction) => {
    const { rows } = await transaction.query(
      `SELECT ${CHUNK_SELECT}, (1 - (c.embedding <=> $4::vector))::float8 AS similarity
       FROM entry_chunks c
       JOIN entries e ON e.id = c.entry_id
       WHERE c.user_id = $1 ${DATE_FILTER}
         AND c.embedding_model = $5
       ORDER BY c.embedding <=> $4::vector
       LIMIT $6`,
      [userId, from ?? null, to ?? null, toVector(embedding), getEmbeddingModelId(), limit],
    );
    return rows;
  });
}

/**
 * Keyword search scored like BM25's core idea: each matching term adds its
 * inverse document frequency, computed over this user's own chunks, so a rare
 * word (a name, a place) counts for much more than a common one.
 * websearch_to_tsquery is not used because it ANDs the terms, which returns
 * nothing for a natural-language question.
 */
async function keywordCandidates({ userId, query, from, to, limit }) {
  const terms = keywordTerms(query);
  if (terms.length === 0) return [];
  const { rows } = await db.query(
    `WITH term AS (
       -- numnode() = 0 means Postgres reduced the word to nothing (a stopword).
       SELECT word, to_tsquery('english', word) AS q
       FROM unnest($4::text[]) AS word
       WHERE numnode(to_tsquery('english', word)) > 0
     ),
     corpus AS (
       SELECT count(*)::float8 AS size FROM entry_chunks WHERE user_id = $1
     ),
     weight AS (
       SELECT term.word, term.q,
              ln(1 + (corpus.size - count(c.id) + 0.5) / (count(c.id) + 0.5)) AS idf
       FROM term
       CROSS JOIN corpus
       LEFT JOIN entry_chunks c ON c.user_id = $1 AND c.search @@ term.q
       GROUP BY term.word, term.q, corpus.size
     ),
     scored AS (
       SELECT c.id, sum(weight.idf) AS score
       FROM entry_chunks c
       JOIN weight ON c.search @@ weight.q
       WHERE c.user_id = $1
       GROUP BY c.id
     )
     SELECT ${CHUNK_SELECT},
            scored.score::float8 AS keyword_score,
            (scored.score / NULLIF((SELECT sum(idf) FROM weight), 0))::float8 AS coverage
     FROM scored
     JOIN entry_chunks c ON c.id = scored.id
     JOIN entries e ON e.id = c.entry_id
     WHERE true ${DATE_FILTER}
     ORDER BY scored.score DESC, e.entry_date DESC
     LIMIT $5`,
    [userId, from ?? null, to ?? null, terms, limit],
  );
  return rows.filter((row) => row.coverage >= MIN_KEYWORD_COVERAGE);
}

/**
 * @param {object}  options
 * @param {string}  options.userId
 * @param {string}  options.query          natural-language question
 * @param {number[]} [options.embedding]   precomputed query embedding
 * @param {string}  [options.from]         inclusive 'YYYY-MM-DD' lower bound
 * @param {string}  [options.to]           inclusive 'YYYY-MM-DD' upper bound
 * @param {number}  [options.limit]        entries to return
 * @param {'hybrid'|'vector'|'keyword'} [options.mode]
 */
export async function searchJournal({
  userId,
  query,
  embedding,
  from,
  to,
  limit = 6,
  candidates = 30,
  chunksPerEntry = 2,
  mode = 'hybrid',
}) {
  const timings = {};
  let started = performance.now();

  let queryEmbedding = embedding;
  if (mode !== 'keyword' && !queryEmbedding) {
    queryEmbedding = await embedQuery(query);
    timings.embedMs = performance.now() - started;
  }

  started = performance.now();
  const [vectorRows, keywordRows] = await Promise.all([
    mode === 'keyword' ? [] : vectorCandidates({ userId, embedding: queryEmbedding, from, to, limit: candidates }),
    mode === 'vector' ? [] : keywordCandidates({ userId, query, from, to, limit: candidates }),
  ]);
  timings.searchMs = performance.now() - started;

  const fused = reciprocalRankFusion([vectorRows.map((row) => row.chunk_id), keywordRows.map((row) => row.chunk_id)]);

  const chunkById = new Map();
  for (const row of [...vectorRows, ...keywordRows]) {
    const existing = chunkById.get(row.chunk_id);
    chunkById.set(row.chunk_id, { ...existing, ...row });
  }

  // Group chunks by entry; an entry ranks by its best chunk.
  const byEntry = new Map();
  for (const [chunkId, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
    const chunk = chunkById.get(chunkId);
    let entry = byEntry.get(chunk.entry_id);
    if (!entry) {
      entry = {
        entryId: chunk.entry_id,
        title: chunk.title,
        entryDate: chunk.entry_date,
        mood: chunk.mood,
        tags: chunk.tags,
        score,
        similarity: null,
        chunks: [],
      };
      byEntry.set(chunk.entry_id, entry);
    }
    if (typeof chunk.similarity === 'number') {
      entry.similarity = Math.max(entry.similarity ?? -1, chunk.similarity);
    }
    if (entry.chunks.length < chunksPerEntry) {
      entry.chunks.push({ chunkIndex: chunk.chunk_index, content: chunk.content });
    }
  }

  const results = [...byEntry.values()].slice(0, limit);
  results.forEach((entry) => entry.chunks.sort((a, b) => a.chunkIndex - b.chunkIndex));
  return { results, timings };
}

/** Most recent entries inside a date window, used to give time-scoped questions full coverage. */
export async function entriesInRange({ userId, from, to, limit = 10, excerptLength = 900 }) {
  const { rows } = await db.query(
    `SELECT id, title, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, mood, tags,
            left(content, $5) AS excerpt, length(content) > $5 AS truncated
     FROM entries
     WHERE user_id = $1 AND entry_date >= $2::date AND entry_date <= $3::date
     ORDER BY entry_date DESC, id DESC
     LIMIT $4`,
    [userId, from, to, limit, excerptLength],
  );
  return rows.map((row) => ({
    entryId: row.id,
    title: row.title,
    entryDate: row.entry_date,
    mood: row.mood,
    tags: row.tags,
    score: 0,
    similarity: null,
    chunks: [{ chunkIndex: 0, content: row.truncated ? `${row.excerpt.trimEnd()} …` : row.excerpt }],
  }));
}

/** Entries whose content is closest to the given entry ("related entries"). */
export async function relatedEntries({ userId, entryId, limit = 4 }) {
  return db.vectorTx(async (transaction) => {
    const { rows } = await transaction.query(
      `WITH source AS (
         SELECT avg(embedding) AS centroid FROM entry_chunks WHERE entry_id = $2 AND user_id = $1
       )
       SELECT e.id, e.title, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.mood, e.tags,
              left(e.content, 200) AS excerpt,
              max(1 - (c.embedding <=> source.centroid))::float8 AS similarity
       FROM entry_chunks c
       JOIN entries e ON e.id = c.entry_id
       CROSS JOIN source
       WHERE c.user_id = $1 AND c.entry_id <> $2 AND c.embedding_model = $3
         AND source.centroid IS NOT NULL
       GROUP BY e.id
       ORDER BY similarity DESC
       LIMIT $4`,
      [userId, entryId, getEmbeddingModelId(), limit],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      entryDate: row.entry_date,
      mood: row.mood,
      tags: row.tags,
      excerpt: row.excerpt,
      similarity: row.similarity,
    }));
  });
}
