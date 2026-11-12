import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { createUser, startApp, stopApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
});
after(stopApp);

const cookiePair = (setCookie) => setCookie[0].split(';')[0];
const refresh = (cookie) => (cookie ? request(app).post('/api/auth/refresh').set('Cookie', cookie) : request(app).post('/api/auth/refresh'));

describe('registration', () => {
  it('creates an account, returns an access token and sets an httpOnly refresh cookie', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'Ada@Example.com', password: 'a-long-password' });

    assert.equal(response.status, 201);
    assert.partialDeepStrictEqual(response.body.user, { name: 'Ada', email: 'ada@example.com' });
    assert.equal(response.body.user.password_hash, undefined);
    assert.equal(typeof response.body.accessToken, 'string');

    const cookie = response.headers['set-cookie'][0];
    assert.match(cookie, /^inkwell_rt=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/api\/auth/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  it('never stores the password in clear text', async () => {
    const { rows } = await db.query(`SELECT password_hash FROM users WHERE email = 'ada@example.com'`);
    assert.match(rows[0].password_hash, /^\$2[aby]\$/);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada again', email: 'ADA@example.com', password: 'another-password' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'email_taken');
  });

  it('validates input', async () => {
    const response = await request(app).post('/api/auth/register').send({ name: '', email: 'nope', password: 'short' });
    assert.equal(response.status, 422);
    assert.deepEqual(response.body.error.details.map((detail) => detail.field).sort(), ['email', 'name', 'password']);
  });
});

describe('login', () => {
  it('accepts correct credentials', async () => {
    const response = await request(app).post('/api/auth/login').send({ email: 'ada@example.com', password: 'a-long-password' });
    assert.equal(response.status, 200);
    assert.equal(typeof response.body.accessToken, 'string');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: 'ada@example.com', password: 'wrong-password' });
    const unknownEmail = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
  });
});

describe('access tokens', () => {
  it('protects private routes', async () => {
    assert.equal((await request(app).get('/api/auth/me')).status, 401);
    assert.equal((await request(app).get('/api/entries')).status, 401);
    const forged = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not.a.token');
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error.code, 'invalid_token');
  });

  it('identifies the caller', async () => {
    const user = await createUser(app);
    const response = await user.get('/api/auth/me');
    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, user.user.id);
  });
});

describe('refresh token rotation', () => {
  it('issues a new token pair and invalidates the old refresh token', async () => {
    const user = await createUser(app);
    const first = cookiePair(user.cookie);

    const refreshed = await refresh(first);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.user.id, user.user.id);
    const second = cookiePair(refreshed.headers['set-cookie']);
    assert.notEqual(second, first);

    assert.equal((await refresh(second)).status, 200);
  });

  it('revokes the whole session family when a rotated token is replayed', async () => {
    const user = await createUser(app);
    const stolen = cookiePair(user.cookie);
    const refreshed = await refresh(stolen);
    const current = cookiePair(refreshed.headers['set-cookie']);

    // Move the rotation outside the grace window that tolerates two-tab races.
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL AND user_id = $1`,
      [user.user.id],
    );

    const replay = await refresh(stolen);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'refresh_token_reused');

    // The legitimate holder of the newest token is signed out too.
    assert.equal((await refresh(current)).status, 401);
  });

  it('treats an immediate double refresh as a race, not a theft', async () => {
    const user = await createUser(app);
    const original = cookiePair(user.cookie);
    const winner = await refresh(original);
    const loser = await refresh(original);

    assert.equal(loser.status, 401);
    assert.equal(loser.body.error.code, 'refresh_race');
    // The session that won the race keeps working.
    assert.equal((await refresh(cookiePair(winner.headers['set-cookie']))).status, 200);
  });

  it('rejects a missing or unknown refresh token', async () => {
    assert.equal((await refresh()).status, 401);
    assert.equal((await refresh('inkwell_rt=made-up')).status, 401);
  });

  it('logout revokes the session', async () => {
    const user = await createUser(app);
    const cookie = cookiePair(user.cookie);
    assert.equal((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status, 204);
    assert.equal((await refresh(cookie)).status, 401);
  });
});

describe('account management', () => {
  it('updates the profile name', async () => {
    const user = await createUser(app);
    const response = await user.patch('/api/auth/me').send({ name: 'Renamed' });
    assert.equal(response.body.user.name, 'Renamed');
  });

  it('changes the password and signs out other sessions', async () => {
    const user = await createUser(app);
    const oldCookie = cookiePair(user.cookie);
    const { email, password } = user.credentials;

    const wrong = await user.post('/api/auth/change-password').send({ currentPassword: 'nope', newPassword: 'brand-new-password' });
    assert.equal(wrong.status, 401);

    const changed = await user.post('/api/auth/change-password').send({ currentPassword: password, newPassword: 'brand-new-password' });
    assert.equal(changed.status, 200);

    assert.equal((await refresh(oldCookie)).status, 401);
    assert.equal((await request(app).post('/api/auth/login').send({ email, password })).status, 401);
    assert.equal((await request(app).post('/api/auth/login').send({ email, password: 'brand-new-password' })).status, 200);
  });

  it('deletes the account and everything that belongs to it', async () => {
    const user = await createUser(app);
    assert.equal((await user.delete('/api/auth/me').send({ password: 'wrong' })).status, 401);
    assert.equal((await user.delete('/api/auth/me').send({ password: user.credentials.password })).status, 204);

    const users = await db.query('SELECT 1 FROM users WHERE id = $1', [user.user.id]);
    assert.equal(users.rows.length, 0);
    const tokens = await db.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1', [user.user.id]);
    assert.equal(tokens.rows.length, 0);
  });
});

describe('errors', () => {
  it('returns JSON for unknown routes and malformed bodies', async () => {
    const missing = await request(app).get('/api/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');

    const malformed = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    assert.equal(malformed.status, 400);
  });

  it('reports health and feature flags', async () => {
    assert.deepEqual((await request(app).get('/api/health')).body, { status: 'ok' });
    const config = await request(app).get('/api/config');
    assert.partialDeepStrictEqual(config.body.features, { attachments: false, assistant: false, semanticEmbeddings: false });
  });
});
