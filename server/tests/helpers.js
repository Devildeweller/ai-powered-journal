import './setup.js';
import { mock } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { jobs } from '../src/services/jobs.js';
import { llm } from '../src/services/llm.js';

/** Boots the app against a fresh in-memory Postgres (PGlite).  Each test file runs in its own process. */
export async function startApp() {
  await migrate();
  return createApp();
}

export async function stopApp() {
  await jobs.drain();
  await db.close();
}

/**
 * Replaces the real model with mocks so no test can reach the Gemini API.
 * By default the chat model fails loudly and memory extraction finds nothing.
 */
export function fakeLlm() {
  const streamChat = mock.fn(async () => {
    throw new Error('streamChat was called without a prepared answer');
  });
  const generateStructured = mock.fn(async () => ({ operations: [] }));
  llm.streamChat = streamChat;
  llm.generateStructured = generateStructured;

  return {
    streamChat,
    generateStructured,
    /** The next chat call streams `text` in two pieces. */
    answerWith(text) {
      streamChat.mock.mockImplementationOnce(async ({ onText }) => {
        const middle = Math.ceil(text.length / 2);
        onText(text.slice(0, middle));
        onText(text.slice(middle));
        return { text, model: 'fake-model', stopReason: 'completed', usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 0 } };
      });
    },
    /** The next memory extraction returns these operations. */
    extractWith(operations) {
      generateStructured.mock.mockImplementationOnce(async () => ({ operations }));
    },
    lastChatRequest: () => streamChat.mock.calls.at(-1).arguments[0],
    lastExtractionRequest: () => generateStructured.mock.calls.at(-1).arguments[0],
    reset() {
      streamChat.mock.resetCalls();
      generateStructured.mock.resetCalls();
    },
  };
}

let counter = 0;

/** Registers a new user and returns request helpers bound to their access token. */
export async function createUser(app, overrides = {}) {
  counter += 1;
  const credentials = {
    name: `Tester ${counter}`,
    email: `tester${counter}-${Date.now()}@example.com`,
    password: 'correct-horse-battery',
    ...overrides,
  };
  const response = await request(app).post('/api/auth/register').send(credentials);
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);

  const token = response.body.accessToken;
  const authed = (method, url) => request(app)[method](url).set('Authorization', `Bearer ${token}`);
  return {
    credentials,
    user: response.body.user,
    token,
    cookie: response.headers['set-cookie'],
    get: (url) => authed('get', url),
    post: (url) => authed('post', url),
    patch: (url) => authed('patch', url),
    delete: (url) => authed('delete', url),
  };
}

/** Parses a text/event-stream body into [{ event, data }]. */
export function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return event ? { event, data: data ? JSON.parse(data) : null } : null;
    })
    .filter(Boolean);
}

export const titles = (items) => items.map((item) => item.title);
