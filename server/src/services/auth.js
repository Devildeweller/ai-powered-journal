import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { generateRefreshToken, hashToken, signAccessToken } from '../utils/tokens.js';

// bcrypt cost 12 ≈ 250 ms per hash: slow enough to make offline guessing
// expensive, fast enough for a login.  Tests use the minimum to stay quick.
const BCRYPT_COST = env.isTest ? 4 : 12;
const REFRESH_TTL_MS = env.refreshTokenTtlDays * 86_400_000;
// Two tabs can refresh with the same cookie at the same instant.  A token
// presented within this window of its rotation is a race, not a theft.
const ROTATION_GRACE_MS = 10_000;

const USER_COLUMNS = 'id, email, name, created_at';

export const toPublicUser = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  createdAt: row.created_at,
});

let dummyHash;
/** Compared against when the email is unknown, so both outcomes take the same time. */
async function getDummyHash() {
  dummyHash ??= await bcrypt.hash('inkwell-timing-equaliser', BCRYPT_COST);
  return dummyHash;
}

export async function registerUser({ name, email, password }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
      [email, name, passwordHash],
    );
    return toPublicUser(rows[0]);
  } catch (error) {
    // 23505 = unique_violation on lower(email).
    if (error?.code === '23505') {
      throw ApiError.conflict('An account with this email already exists.', { code: 'email_taken' });
    }
    throw error;
  }
}

export async function authenticate({ email, password }) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`, [email]);
  const user = rows[0];
  const matches = await bcrypt.compare(password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !matches) {
    throw ApiError.unauthorized('Incorrect email or password.', { code: 'invalid_credentials' });
  }
  return toPublicUser(user);
}

export async function getUser(userId) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return rows[0] ? toPublicUser(rows[0]) : null;
}

/** Issues an access token plus a refresh token belonging to `familyId` (a new family per login). */
export async function createSession(userId, { userAgent, familyId = crypto.randomUUID() } = {}) {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, familyId, hashToken(refreshToken), userAgent?.slice(0, 300) ?? null, expiresAt],
  );
  return { accessToken: signAccessToken(userId), refreshToken, refreshExpiresAt: expiresAt };
}

/**
 * Refresh-token rotation with reuse detection.
 * Each refresh token works once.  Presenting one that was already rotated
 * means it leaked (or was replayed), so the whole family is revoked and the
 * legitimate user has to sign in again.
 */
export async function rotateSession(refreshToken, { userAgent } = {}) {
  const invalid = () => ApiError.unauthorized('Session expired. Please sign in again.', { code: 'invalid_refresh_token' });
  if (!refreshToken) throw invalid();

  const { rows } = await db.query(
    `SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
    [hashToken(refreshToken)],
  );
  const stored = rows[0];
  if (!stored) throw invalid();

  if (stored.revoked_at) {
    const sinceRevoked = Date.now() - new Date(stored.revoked_at).getTime();
    if (sinceRevoked > ROTATION_GRACE_MS) {
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
        stored.family_id,
      ]);
    }
    throw ApiError.unauthorized('Session expired. Please sign in again.', {
      code: sinceRevoked > ROTATION_GRACE_MS ? 'refresh_token_reused' : 'refresh_race',
    });
  }
  if (new Date(stored.expires_at).getTime() <= Date.now()) throw invalid();

  // Atomic claim: only one concurrent request can flip revoked_at.
  const claimed = await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [
    stored.id,
  ]);
  if (claimed.rows.length === 0) throw ApiError.unauthorized('Session expired. Please sign in again.', { code: 'refresh_race' });

  const session = await createSession(stored.user_id, { userAgent, familyId: stored.family_id });
  return { ...session, userId: stored.user_id };
}

/** Sign out: revoke the presented token's whole family. */
export async function revokeSession(refreshToken) {
  if (!refreshToken) return;
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE revoked_at IS NULL
       AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
    [hashToken(refreshToken)],
  );
}

export async function revokeAllSessions(userId) {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

/** Housekeeping on login: drop this user's tokens that expired over a week ago. */
export async function pruneExpiredTokens(userId) {
  await db.query(`DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < now() - interval '7 days'`, [userId]);
}

export async function updateProfile(userId, { name }) {
  const { rows } = await db.query(
    `UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [userId, name],
  );
  return rows[0] ? toPublicUser(rows[0]) : null;
}

async function assertPassword(userId, password) {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    throw ApiError.unauthorized('Current password is incorrect.', { code: 'invalid_credentials' });
  }
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  await assertPassword(userId, currentPassword);
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, passwordHash]);
  // Changing the password signs out every device.
  await revokeAllSessions(userId);
}

/** Deletes the account; every table references users with ON DELETE CASCADE. */
export async function deleteAccount(userId, { password }) {
  await assertPassword(userId, password);
  const { rows } = await db.query('SELECT storage_key FROM attachments WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
  return { storageKeys: rows.map((row) => row.storage_key) };
}
