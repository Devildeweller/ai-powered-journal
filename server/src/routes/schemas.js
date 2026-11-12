import { z } from 'zod';
import { isIsoDate } from '../utils/temporal.js';

/** Validation pieces shared by several routers. */

export const idParams = z.object({ id: z.uuid('Invalid id.') });

export const isoDate = z.string().refine(isIsoDate, 'Expected a date in YYYY-MM-DD format.');

/** "Today" in the user's own time zone, sent by the client; the server clock may be a day off. */
export const clientToday = isoDate.optional();

export const tagList = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .max(10, 'An entry can have at most 10 tags.')
  .transform((tags) => [...new Set(tags.map((tag) => tag.replace(/\s+/g, '-')))]);
