import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const ISSUER = 'inkwell';
const ALGORITHM = 'HS256';

/** Short-lived, stateless access token.  The user id travels in the `sub` claim. */
export function signAccessToken(userId) {
  return jwt.sign({}, env.jwtSecret, {
    subject: userId,
    issuer: ISSUER,
    algorithm: ALGORITHM,
    expiresIn: env.accessTokenTtl,
  });
}

/** Throws if the token is expired, tampered with, or signed with another algorithm. */
export function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.jwtSecret, { issuer: ISSUER, algorithms: [ALGORITHM] });
  return { userId: payload.sub };
}

/** Refresh tokens are opaque: 48 random bytes, never stored in clear text. */
export function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
