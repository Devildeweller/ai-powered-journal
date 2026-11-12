/**
 * HTTP client for the Inkwell API.
 *
 * Token handling:
 *  - The access token (a short-lived JWT) lives only in this module's memory,
 *    never in localStorage, so injected scripts cannot read it from storage.
 *  - The refresh token is an httpOnly cookie the browser sends to /api/auth.
 *  - When a request comes back 401, the client refreshes once and retries.
 *    Concurrent 401s share a single refresh call.
 */

const BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

let accessToken = null;
let refreshInFlight = null;
let onSessionLost = () => {};

export function setAccessToken(token) {
  accessToken = token;
}

/** Called when the session cannot be refreshed, so the app can show the sign-in page. */
export function setSessionLostHandler(handler) {
  onSessionLost = handler;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? 'Something went wrong. Please try again.');
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'error';
    this.details = body?.error?.details ?? [];
  }

  /** Validation messages keyed by field name, for showing next to inputs. */
  get fieldErrors() {
    return Object.fromEntries(this.details.map((detail) => [detail.field, detail.message]));
  }
}

function buildUrl(path, query) {
  const url = `${BASE_URL}/api${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  const queryString = params.toString();
  return queryString ? `${url}?${queryString}` : url;
}

async function parseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestRefresh() {
  const call = () => fetch(buildUrl('/auth/refresh'), { method: 'POST', credentials: 'include' });
  let response = await call();
  let body = await parseBody(response);
  // Another tab rotated the cookie a moment ago; its new cookie is already in
  // the jar, so one retry succeeds.
  if (response.status === 401 && body?.error?.code === 'refresh_race') {
    await wait(400);
    response = await call();
    body = await parseBody(response);
  }
  if (!response.ok) throw new ApiError(response.status, body);
  accessToken = body.accessToken;
  return body;
}

/** Exchanges the refresh cookie for a new access token.  Returns { user, accessToken }. */
export function refreshSession() {
  refreshInFlight ??= requestRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function send(path, { method = 'GET', body, query, signal, headers } = {}) {
  return fetch(buildUrl(path, query), {
    method,
    signal,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Sends a request and, on an expired access token, refreshes and retries once. */
async function sendWithRefresh(path, options) {
  let response = await send(path, options);
  if (response.status === 401 && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
    } catch {
      accessToken = null;
      onSessionLost();
      throw new ApiError(401, { error: { code: 'session_expired', message: 'Your session has expired. Please sign in again.' } });
    }
    response = await send(path, options);
  }
  return response;
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await (options.skipRefresh ? send(path, options) : sendWithRefresh(path, options));
  } catch (error) {
    if (error instanceof ApiError || error.name === 'AbortError') throw error;
    throw new ApiError(0, { error: { code: 'network_error', message: 'Cannot reach the server. Check your connection and try again.' } });
  }
  const body = await parseBody(response);
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

/**
 * POST /api/chat and consume its Server-Sent Events.
 * EventSource cannot send a POST body or an Authorization header, so the
 * stream is read from fetch() and parsed here.
 *
 * `onEvent(name, data)` is called for: conversation, status, sources, delta, done, error.
 */
export async function streamChat({ message, conversationId, today, signal, onEvent }) {
  let response;
  try {
    response = await sendWithRefresh('/chat', {
      method: 'POST',
      body: { message, conversationId, today },
      signal,
      headers: { Accept: 'text/event-stream' },
    });
  } catch (error) {
    if (error instanceof ApiError || error.name === 'AbortError') throw error;
    throw new ApiError(0, { error: { code: 'network_error', message: 'Cannot reach the server. Check your connection and try again.' } });
  }
  if (!response.ok) throw new ApiError(response.status, await parseBody(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block) => {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      // Lines starting with ":" are keep-alive comments.
    }
    if (dataLines.length === 0) return;
    try {
      onEvent(event, JSON.parse(dataLines.join('\n')));
    } catch {
      // Ignore a malformed frame rather than abandon the whole answer.
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

/** Uploads a file straight to S3 using a presigned URL from the API. */
export async function uploadToPresignedUrl(uploadUrl, file, headers) {
  const response = await fetch(uploadUrl, { method: 'PUT', body: file, headers });
  if (!response.ok) {
    throw new ApiError(response.status, { error: { code: 'upload_failed', message: 'The upload was rejected by storage. Please try again.' } });
  }
}
