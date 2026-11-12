import { z } from 'zod';
import { db, toVector } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { embedDocuments, embedQuery, getEmbeddingModelId, getRelevanceFloor } from './embeddings.js';
import { jobs } from './jobs.js';
import { llm } from './llm.js';

/**
 * Long-term memory.
 *
 * Journal retrieval answers "what did I write about X".  Memory answers "who
 * is this person": durable facts (people in their life, goals, preferences,
 * recurring patterns) distilled once and then recalled in every conversation,
 * including brand-new ones that share no chat history.
 *
 *   write path: after a chat exchange or a new journal entry, the model compares
 *               the new text with the closest existing memories and returns
 *               add / update / delete operations (so facts get corrected
 *               rather than duplicated).
 *   read path:  memories are ranked by similarity to the question, blended
 *               with importance and recency; "core" memories always ride along.
 */

export const MEMORY_CATEGORIES = [
  'identity',
  'relationship',
  'goal',
  'preference',
  'health',
  'work',
  'event',
  'pattern',
  'other',
];

const MEMORY_COLUMNS = `id, content, category, importance, source_type, source_conversation_id, source_entry_id,
  access_count, last_accessed_at, created_at, updated_at`;

export function toMemory(row) {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    importance: row.importance,
    sourceType: row.source_type,
    sourceConversationId: row.source_conversation_id,
    sourceEntryId: row.source_entry_id,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -------------------------------------------------------------------- CRUD --

export async function listMemories(userId, { category } = {}) {
  const { rows } = await db.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories
     WHERE user_id = $1 AND archived_at IS NULL AND ($2::text IS NULL OR category = $2)
     ORDER BY importance DESC, updated_at DESC`,
    [userId, category ?? null],
  );
  return rows.map(toMemory);
}

export async function createMemory(userId, { content, category = 'other', importance = 3, source = {} }) {
  const [embedding] = await embedDocuments([content]);
  const { rows } = await db.query(
    `INSERT INTO memories (user_id, content, category, importance, embedding, embedding_model,
                           source_type, source_conversation_id, source_entry_id)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9)
     RETURNING ${MEMORY_COLUMNS}`,
    [
      userId,
      content,
      category,
      importance,
      toVector(embedding),
      getEmbeddingModelId(),
      source.type ?? 'manual',
      source.conversationId ?? null,
      source.entryId ?? null,
    ],
  );
  return toMemory(rows[0]);
}

export async function updateMemory(userId, memoryId, { content, category, importance }) {
  let embedding = null;
  if (content !== undefined) [embedding] = await embedDocuments([content]);
  const { rows } = await db.query(
    `UPDATE memories SET
       content = COALESCE($3, content),
       category = COALESCE($4, category),
       importance = COALESCE($5, importance),
       embedding = COALESCE($6::vector, embedding),
       embedding_model = CASE WHEN $6::vector IS NULL THEN embedding_model ELSE $7 END,
       updated_at = now()
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
     RETURNING ${MEMORY_COLUMNS}`,
    [
      memoryId,
      userId,
      content ?? null,
      category ?? null,
      importance ?? null,
      embedding ? toVector(embedding) : null,
      getEmbeddingModelId(),
    ],
  );
  return rows[0] ? toMemory(rows[0]) : null;
}

export async function deleteMemory(userId, memoryId) {
  const { rows } = await db.query('DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id', [memoryId, userId]);
  return rows.length > 0;
}

// --------------------------------------------------------------- retrieval --

const DAY_MS = 86_400_000;

/** Exponential decay with a 90-day half-life: old memories fade but never vanish. */
function recencyScore(updatedAt, now = Date.now()) {
  const ageDays = Math.max(0, (now - new Date(updatedAt).getTime()) / DAY_MS);
  return 0.5 ** (ageDays / 90);
}

export function scoreMemory({ similarity, importance, updatedAt }, now = Date.now()) {
  return 0.65 * similarity + 0.2 * (importance / 5) + 0.15 * recencyScore(updatedAt, now);
}

async function nearestMemories(userId, embedding, limit) {
  return db.vectorTx(async (transaction) => {
    const { rows } = await transaction.query(
      `SELECT ${MEMORY_COLUMNS}, (1 - (embedding <=> $2::vector))::float8 AS similarity
       FROM memories
       WHERE user_id = $1 AND archived_at IS NULL AND embedding_model = $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [userId, toVector(embedding), getEmbeddingModelId(), limit],
    );
    return rows;
  });
}

/**
 * Memories to place in the prompt for a question: the best semantic matches
 * plus the user's core memories (importance 5), which apply to any topic.
 */
export async function recallMemories(userId, embedding, { limit = 6, coreLimit = 4 } = {}) {
  const [nearest, core] = await Promise.all([
    embedding ? nearestMemories(userId, embedding, 20) : [],
    db
      .query(
        `SELECT ${MEMORY_COLUMNS} FROM memories
         WHERE user_id = $1 AND archived_at IS NULL AND importance = 5
         ORDER BY updated_at DESC LIMIT $2`,
        [userId, coreLimit],
      )
      .then((result) => result.rows),
  ]);

  const floor = getRelevanceFloor();
  const relevant = nearest
    .filter((row) => row.similarity >= floor)
    .map((row) => ({
      row,
      score: scoreMemory({ similarity: row.similarity, importance: row.importance, updatedAt: row.updated_at }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => row);

  const seen = new Set();
  const selected = [];
  for (const row of [...core, ...relevant]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    selected.push({ ...toMemory(row), similarity: row.similarity ?? null });
  }

  if (selected.length > 0) {
    // Usage statistics are best-effort; never fail a chat over them.
    db.query(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = now() WHERE id = ANY($1::uuid[])`,
      [selected.map((memory) => memory.id)],
    ).catch((error) => logger.warn({ err: error }, 'could not record memory access'));
  }
  return selected;
}

// -------------------------------------------------------------- extraction --

const operationsSchema = z.object({
  operations: z.array(
    z.object({
      action: z.enum(['add', 'update', 'delete']),
      // Number of the existing memory to update or delete; null for "add".
      existing_memory: z.number().nullable(),
      content: z.string(),
      category: z.enum(MEMORY_CATEGORIES),
      importance: z.number(),
    }),
  ),
});

// The same shape as operationsSchema, in the JSON Schema dialect the model's
// structured-output mode accepts.  The model is constrained to it while
// generating; zod then validates what came back.
const operationsJsonSchema = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'delete'] },
          existing_memory: { type: ['integer', 'null'], description: 'Number of the existing memory to update or delete; null for add.' },
          content: { type: 'string' },
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          importance: { type: 'integer', minimum: 1, maximum: 5, description: '1 (minor) to 5 (core).' },
        },
        required: ['action', 'existing_memory', 'content', 'category', 'importance'],
      },
    },
  },
  required: ['operations'],
};

const EXTRACTION_SYSTEM = `You maintain the long-term memory of a private journaling assistant. Your job is to decide what, if anything, from a new piece of text is worth remembering about the user in future conversations, months from now.

Worth remembering: stable facts about who they are; people in their life (name, relationship, what matters about them); goals and plans; strong preferences and values; health and wellbeing facts; their work or studies; significant life events with their dates; recurring patterns in how they feel or behave.

Not worth remembering: passing moods, one-off chores, what they ate, small talk, things the assistant said, or anything the text only speculates about. Most texts contain nothing new, and returning an empty list of operations is the usual, correct outcome.

You are shown the existing memories most related to the new text, each with a number.
- "add": a genuinely new fact. Set existing_memory to null.
- "update": the text refines, extends or corrects an existing memory. Set existing_memory to its number and write the full replacement text, keeping what is still true.
- "delete": the text shows an existing memory is no longer true and nothing replaces it. Set existing_memory to its number.
Do not add something an existing memory already says.

Write each memory as one self-contained sentence in the third person ("The user ..."), specific enough to be useful without the original text. Use absolute dates (the text's date is given) rather than "yesterday" or "last week". Record only what the user stated or what the text clearly shows.

importance is 1 to 5: 5 for core identity and the most important people and long-term goals, 3 for ordinary useful facts, 1 for minor details.`;

function clampImportance(value) {
  const rounded = Math.round(Number(value));
  return Number.isFinite(rounded) ? Math.min(5, Math.max(1, rounded)) : 3;
}

/**
 * Runs one extraction pass over `text` and applies the resulting operations.
 * Returns { added, updated, deleted } counts.
 */
export async function extractMemories({ userId, text, sourceLabel, source }) {
  const result = { added: 0, updated: 0, deleted: 0 };
  const trimmed = text.trim();
  if (trimmed.length < 40) return result;

  const queryEmbedding = await embedQuery(trimmed.slice(0, 4000));
  const existing = await nearestMemories(userId, queryEmbedding, 12);

  const existingBlock = existing.length
    ? existing.map((row, index) => `${index + 1}. [${row.category}, importance ${row.importance}] ${row.content}`).join('\n')
    : '(none yet)';

  const parsed = await llm.generateStructured({
    system: EXTRACTION_SYSTEM,
    schema: operationsSchema,
    jsonSchema: operationsJsonSchema,
    prompt: `<existing_memories>\n${existingBlock}\n</existing_memories>\n\n<new_text source="${sourceLabel}">\n${trimmed.slice(0, 12000)}\n</new_text>`,
  });
  if (!parsed) {
    logger.warn({ source: sourceLabel }, 'memory extraction returned no usable output');
    return result;
  }
  logger.debug({ source: sourceLabel, proposed: parsed.operations.length }, 'memory extraction finished');

  for (const operation of parsed.operations.slice(0, 8)) {
    const target = operation.existing_memory ? existing[operation.existing_memory - 1] : null;
    const content = operation.content.trim().slice(0, 600);

    if (operation.action === 'delete') {
      if (!target) continue;
      await db.query('UPDATE memories SET archived_at = now() WHERE id = $1 AND user_id = $2', [target.id, userId]);
      result.deleted += 1;
    } else if (operation.action === 'update') {
      if (!target || !content) continue;
      const updated = await updateMemory(userId, target.id, {
        content,
        category: operation.category,
        importance: clampImportance(operation.importance),
      });
      if (updated) result.updated += 1;
    } else if (content) {
      // Guard against near-duplicates the model failed to recognise.
      const [embedding] = await embedDocuments([content]);
      const [closest] = await nearestMemories(userId, embedding, 1);
      if (closest && closest.similarity > 0.93) continue;
      await createMemory(userId, {
        content,
        category: operation.category,
        importance: clampImportance(operation.importance),
        source,
      });
      result.added += 1;
    }
  }
  return result;
}

/** Fire-and-forget extraction after a chat exchange. */
export function enqueueChatExtraction({ userId, conversationId, userText, assistantText, today }) {
  if (!env.memoryExtraction || userText.trim().length < 20) return;
  jobs.add(
    `memory-chat:${conversationId}`,
    () =>
      extractMemories({
        userId,
        sourceLabel: `chat conversation on ${today}`,
        source: { type: 'chat', conversationId },
        text: `User: ${userText}\n\nAssistant: ${assistantText}`,
      }),
    { retries: 1 },
  );
}

/** Fire-and-forget extraction after a journal entry is written or substantially edited. */
export function enqueueEntryExtraction({ userId, entry }) {
  if (!env.memoryExtraction) return;
  jobs.add(
    `memory-entry:${entry.id}`,
    () =>
      extractMemories({
        userId,
        sourceLabel: `journal entry dated ${entry.entryDate}`,
        source: { type: 'entry', entryId: entry.id },
        text: `${entry.title ? `${entry.title}\n\n` : ''}${entry.content}`,
      }),
    { retries: 1 },
  );
}
