import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

function limiter({ windowMs, limit, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message } });
    },
  });
}

/** Coarse per-IP ceiling for the whole API. */
export const apiLimiter = limiter({
  windowMs: 60_000,
  limit: 300,
  message: 'Too many requests. Please slow down.',
});

/** Tight per-IP limit on credential endpoints to blunt password guessing. */
export const authLimiter = limiter({
  windowMs: 15 * 60_000,
  limit: 20,
  message: 'Too many attempts. Try again in a few minutes.',
});

/** Per-user limit on endpoints that spend model tokens. */
export const aiLimiter = limiter({
  windowMs: 60_000,
  limit: 20,
  message: 'You are sending messages too quickly. Give it a moment.',
  keyGenerator: (req) => `user:${req.user.id}`,
});
