import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { getEmbeddingModelId } from '../services/embeddings.js';
import { getInsights } from '../services/insights.js';
import * as memory from '../services/memory.js';
import * as storage from '../services/storage.js';
import { ApiError } from '../utils/ApiError.js';
import { todayIso } from '../utils/temporal.js';
import { clientToday, idParams } from './schemas.js';

// ------------------------------------------------------------ public: meta --

export const metaRouter = Router();

/** Liveness + database check, used by Render's health probe. */
metaRouter.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

/** Which optional features this deployment has, so the UI can adapt. */
metaRouter.get('/config', (_req, res) => {
  res.json({
    features: {
      attachments: storage.isStorageConfigured(),
      assistant: env.hasGeminiKey,
      semanticEmbeddings: env.embeddingsProvider === 'gemini',
      memoryExtraction: env.memoryExtraction,
    },
    limits: {
      attachmentBytes: storage.MAX_ATTACHMENT_BYTES,
      attachmentsPerEntry: storage.MAX_ATTACHMENTS_PER_ENTRY,
    },
    models: { chat: env.geminiModel, embeddings: getEmbeddingModelId() },
  });
});

// ---------------------------------------------------------------- memories --

export const memoriesRouter = Router();

const memoryContent = z.string().trim().min(3, 'A memory needs a few words.').max(600);
const memoryCategory = z.enum(memory.MEMORY_CATEGORIES);
const memoryImportance = z.number().int().min(1).max(5);

memoriesRouter.get('/', validate({ query: z.object({ category: memoryCategory.optional() }) }), async (req, res) => {
  res.json({ memories: await memory.listMemories(req.user.id, req.valid.query) });
});

memoriesRouter.post(
  '/',
  validate({
    body: z.object({ content: memoryContent, category: memoryCategory.default('other'), importance: memoryImportance.default(3) }),
  }),
  async (req, res) => {
    res.status(201).json({ memory: await memory.createMemory(req.user.id, req.valid.body) });
  },
);

memoriesRouter.patch(
  '/:id',
  validate({
    params: idParams,
    body: z
      .object({ content: memoryContent, category: memoryCategory, importance: memoryImportance })
      .partial()
      .refine((body) => Object.keys(body).length > 0, 'Nothing to update.'),
  }),
  async (req, res) => {
    const updated = await memory.updateMemory(req.user.id, req.valid.params.id, req.valid.body);
    if (!updated) throw ApiError.notFound('Memory not found.');
    res.json({ memory: updated });
  },
);

memoriesRouter.delete('/:id', validate({ params: idParams }), async (req, res) => {
  const deleted = await memory.deleteMemory(req.user.id, req.valid.params.id);
  if (!deleted) throw ApiError.notFound('Memory not found.');
  res.status(204).end();
});

// ------------------------------------------------------------- attachments --

export const attachmentsRouter = Router();

attachmentsRouter.post(
  '/',
  validate({
    body: z.object({
      entryId: z.uuid(),
      fileName: z.string().trim().min(1).max(200),
      contentType: z.string().max(100),
      sizeBytes: z.number().int().positive(),
    }),
  }),
  async (req, res) => {
    res.status(201).json(await storage.createUpload(req.user.id, req.valid.body));
  },
);

attachmentsRouter.post('/:id/complete', validate({ params: idParams }), async (req, res) => {
  res.json({ attachment: await storage.completeUpload(req.user.id, req.valid.params.id) });
});

attachmentsRouter.delete('/:id', validate({ params: idParams }), async (req, res) => {
  const deleted = await storage.deleteAttachment(req.user.id, req.valid.params.id);
  if (!deleted) throw ApiError.notFound('Attachment not found.');
  res.status(204).end();
});

// ---------------------------------------------------------------- insights --

export const insightsRouter = Router();

insightsRouter.get('/', validate({ query: z.object({ today: clientToday }) }), async (req, res) => {
  res.json(await getInsights(req.user.id, { today: req.valid.query.today ?? todayIso() }));
});
