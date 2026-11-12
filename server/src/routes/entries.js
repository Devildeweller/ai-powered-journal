import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import * as entries from '../services/entries.js';
import { relatedEntries, searchJournal } from '../services/retrieval.js';
import { listAttachments, removeObjects } from '../services/storage.js';
import { ApiError } from '../utils/ApiError.js';
import { idParams, isoDate, tagList } from './schemas.js';

const router = Router();

const title = z.string().trim().max(200);
const content = z.string().trim().min(1, 'Write something first.').max(50_000, 'Entries can be at most 50,000 characters.');
const mood = z.number().int().min(1).max(5).nullable();

const createBody = z.object({
  title: title.default(''),
  content,
  mood: mood.default(null),
  tags: tagList.default([]),
  entryDate: isoDate,
});

const updateBody = z
  .object({ title, content, mood, tags: tagList, entryDate: isoDate })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.');

const listQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  tag: z.string().trim().toLowerCase().min(1).max(30).optional(),
  mood: z.coerce.number().int().min(1).max(5).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  res.json(await entries.listEntries(req.user.id, req.valid.query));
});

router.post('/', validate({ body: createBody }), async (req, res) => {
  const entry = await entries.createEntry(req.user.id, req.valid.body);
  res.status(201).json({ entry });
});

router.get('/tags', async (req, res) => {
  res.json({ tags: await entries.listTags(req.user.id) });
});

/** Semantic (hybrid vector + keyword) search across the journal. */
router.get(
  '/search',
  validate({
    query: z.object({
      q: z.string().trim().min(2, 'Type at least two characters.').max(300),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    }),
  }),
  async (req, res) => {
    const { q, limit } = req.valid.query;
    const { results, timings } = await searchJournal({ userId: req.user.id, query: q, limit, chunksPerEntry: 1 });
    res.json({
      results: results.map((result) => ({
        id: result.entryId,
        title: result.title,
        entryDate: result.entryDate,
        mood: result.mood,
        tags: result.tags,
        similarity: result.similarity,
        excerpt: result.chunks[0]?.content.slice(0, 320) ?? '',
      })),
      tookMs: Math.round((timings.embedMs ?? 0) + timings.searchMs),
    });
  },
);

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const entry = await entries.getEntry(req.user.id, req.valid.params.id);
  if (!entry) throw ApiError.notFound('Entry not found.');
  const attachments = await listAttachments(req.user.id, entry.id);
  res.json({ entry: { ...entry, attachments } });
});

router.get('/:id/related', validate({ params: idParams }), async (req, res) => {
  res.json({ related: await relatedEntries({ userId: req.user.id, entryId: req.valid.params.id }) });
});

router.patch('/:id', validate({ params: idParams, body: updateBody }), async (req, res) => {
  const entry = await entries.updateEntry(req.user.id, req.valid.params.id, req.valid.body);
  if (!entry) throw ApiError.notFound('Entry not found.');
  res.json({ entry });
});

router.post('/:id/reindex', validate({ params: idParams }), async (req, res) => {
  const queued = await entries.retryIndexing(req.user.id, req.valid.params.id);
  if (!queued) throw ApiError.notFound('Entry not found.');
  res.status(202).json({ queued: true });
});

router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  const deleted = await entries.deleteEntry(req.user.id, req.valid.params.id);
  if (!deleted) throw ApiError.notFound('Entry not found.');
  await removeObjects(deleted.storageKeys);
  res.status(204).end();
});

export default router;
