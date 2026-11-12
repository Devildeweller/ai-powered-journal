import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import * as auth from '../services/auth.js';
import { removeObjects } from '../services/storage.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

const REFRESH_COOKIE = 'inkwell_rt';
const cookieOptions = {
  // Not readable from JavaScript, so an XSS bug cannot steal the session.
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: env.cookieSameSite,
  // Only ever sent to the auth endpoints, not with every API call.
  path: '/api/auth',
};

function setRefreshCookie(res, session) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...cookieOptions, expires: session.refreshExpiresAt });
}

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.').max(254));
// bcrypt only reads the first 72 bytes of a password, so longer ones are rejected rather than silently truncated.
const password = z.string().min(8, 'Password must be at least 8 characters.').max(72, 'Password must be at most 72 characters.');
const name = z.string().trim().min(1, 'Name is required.').max(80);

router.post(
  '/register',
  authLimiter,
  validate({ body: z.object({ name, email, password }) }),
  async (req, res) => {
    const user = await auth.registerUser(req.valid.body);
    const session = await auth.createSession(user.id, { userAgent: req.get('user-agent') });
    setRefreshCookie(res, session);
    res.status(201).json({ user, accessToken: session.accessToken });
  },
);

router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ email, password: z.string().min(1).max(200) }) }),
  async (req, res) => {
    const user = await auth.authenticate(req.valid.body);
    await auth.pruneExpiredTokens(user.id);
    const session = await auth.createSession(user.id, { userAgent: req.get('user-agent') });
    setRefreshCookie(res, session);
    res.json({ user, accessToken: session.accessToken });
  },
);

/** Exchanges the refresh cookie for a new access token and rotates the cookie. */
router.post('/refresh', async (req, res) => {
  try {
    const session = await auth.rotateSession(req.cookies?.[REFRESH_COOKIE], { userAgent: req.get('user-agent') });
    const user = await auth.getUser(session.userId);
    if (!user) throw ApiError.unauthorized();
    setRefreshCookie(res, session);
    res.json({ user, accessToken: session.accessToken });
  } catch (error) {
    // Keep the cookie during a benign two-tab race so the retry can succeed.
    if (error instanceof ApiError && error.code !== 'refresh_race') res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw error;
  }
});

router.post('/logout', async (req, res) => {
  await auth.revokeSession(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await auth.getUser(req.user.id);
  if (!user) throw ApiError.unauthorized();
  res.json({ user });
});

router.patch('/me', requireAuth, validate({ body: z.object({ name }) }), async (req, res) => {
  const user = await auth.updateProfile(req.user.id, req.valid.body);
  if (!user) throw ApiError.unauthorized();
  res.json({ user });
});

router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate({ body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }) }),
  async (req, res) => {
    await auth.changePassword(req.user.id, req.valid.body);
    // Every session was revoked; start a fresh one for this device.
    const session = await auth.createSession(req.user.id, { userAgent: req.get('user-agent') });
    setRefreshCookie(res, session);
    res.json({ accessToken: session.accessToken });
  },
);

router.delete(
  '/me',
  requireAuth,
  authLimiter,
  validate({ body: z.object({ password: z.string().min(1).max(200) }) }),
  async (req, res) => {
    const { storageKeys } = await auth.deleteAccount(req.user.id, req.valid.body);
    await removeObjects(storageKeys);
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  },
);

export default router;
