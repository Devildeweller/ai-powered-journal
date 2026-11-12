import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * All calls to the language model (Google Gemini) go through the `llm` object
 * exported at the bottom of this module.  That keeps model settings in one
 * place and gives tests a single seam to replace with a fake model.
 *
 * Requests go straight to Gemini's Interactions REST API:
 *  - stateless, with `store: false`: every request carries everything the model
 *    needs and Google is asked not to keep a copy, because the content is a
 *    private journal;
 *  - with a hard timeout, so a struggling upstream can never hang a chat;
 *  - with a fallback chain of models: when one is overloaded or out of quota
 *    (common on the free tier) the next one is tried before anything has been
 *    shown to the user.
 */

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// A healthy model starts streaming within a few seconds.  An overloaded one can
// accept the connection and then send nothing but keep-alives, so each attempt
// is cut off if it has not started producing output in time.
const FIRST_OUTPUT_TIMEOUT_MS = 10_000;
const STALL_TIMEOUT_MS = 45_000;
const UNARY_TIMEOUT_MS = 60_000;
// After a model fails this way it is skipped for a while instead of being retried on every request.
const COOLDOWN_MS = 10 * 60_000;

export class LlmError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message, { cause });
    this.name = 'LlmError';
    this.status = status;
  }
}

/** A failed call to the provider, before it is turned into a user-facing message. */
class ProviderError extends Error {
  constructor(status, message, { code } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }

  /** Worth trying another model: this one is overloaded, out of quota, or unknown to the key. */
  get shouldFallBack() {
    return this.status === 429 || this.status === 404 || this.status >= 500;
  }
}

// The API reports errors inside a stream as a symbolic code rather than an HTTP status.
const STATUS_BY_CODE = {
  service_unavailable: 503,
  unavailable: 503,
  internal: 500,
  deadline_exceeded: 504,
  resource_exhausted: 429,
  rate_limit_exceeded: 429,
  not_found: 404,
  permission_denied: 403,
  unauthenticated: 401,
  invalid_argument: 400,
};

function providerErrorFrom(payload, httpStatus) {
  const error = payload?.error ?? {};
  const status = httpStatus && httpStatus >= 400 ? httpStatus : (STATUS_BY_CODE[error.code] ?? 502);
  return new ProviderError(status, error.message ?? `Gemini request failed (${status}).`, { code: error.code });
}

/** Turns provider errors into messages that are safe and useful to show in the UI. */
export function toLlmError(error) {
  if (error instanceof LlmError) return error;

  if (error instanceof ProviderError) {
    const { status } = error;
    if (status === 401 || status === 403 || (status === 400 && /api key/i.test(error.message))) {
      return new LlmError('The Gemini API key was rejected. Check GEMINI_API_KEY on the server.', { status: 503, cause: error });
    }
    if (status === 429) {
      return new LlmError('The AI service quota is used up for the moment. Please try again in a minute.', { status: 429, cause: error });
    }
    if (status === 404) {
      return new LlmError('The configured AI model is not available for this API key. Check GEMINI_MODEL.', { status: 503, cause: error });
    }
    if (status >= 500) {
      return new LlmError('The AI service is busy right now. Please try again in a moment.', { status: 503, cause: error });
    }
    return new LlmError(`The AI service rejected the request (${status}).`, { cause: error });
  }
  if (error?.name === 'TimeoutError') {
    return new LlmError('The AI service took too long to respond. Please try again.', { status: 504, cause: error });
  }
  if (error?.name === 'TypeError') {
    // fetch() failures: DNS, refused connection, offline.
    return new LlmError('Could not reach the AI service. Check the server network connection.', { status: 503, cause: error });
  }
  return new LlmError('The AI assistant failed unexpectedly.', { cause: error });
}

function assertConfigured() {
  if (!env.geminiApiKey) {
    throw new LlmError('The AI assistant is not configured yet. Add GEMINI_API_KEY to the server environment.', { status: 503 });
  }
}

async function postInteraction(body, signal) {
  const response = await fetch(INTERACTIONS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.geminiApiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw providerErrorFrom(payload, response.status);
  }
  return response;
}

const coolingUntil = new Map();

/**
 * Runs `attempt(model)` over the model chain, moving on only for errors another
 * model could avoid.  Models that recently failed that way are skipped (a small
 * circuit breaker), so one overloaded model does not slow down every request.
 */
async function withModelFallback(attempt, { canFallBack = () => true } = {}) {
  const now = Date.now();
  const healthy = env.geminiModels.filter((model) => (coolingUntil.get(model) ?? 0) <= now);
  // If everything is cooling down, try the whole chain again rather than fail outright.
  const models = healthy.length > 0 ? healthy : env.geminiModels;

  for (let index = 0; ; index += 1) {
    try {
      return await attempt(models[index]);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.shouldFallBack) throw error;
      coolingUntil.set(models[index], Date.now() + COOLDOWN_MS);
      const next = models[index + 1];
      if (!next || !canFallBack()) throw error;
      logger.warn({ model: models[index], status: error.status, next }, 'model unavailable, falling back');
    }
  }
}

const usageOf = (interaction) => ({
  inputTokens: interaction?.usage?.total_input_tokens ?? 0,
  outputTokens: interaction?.usage?.total_output_tokens ?? 0,
  thoughtTokens: interaction?.usage?.total_thought_tokens ?? 0,
});

/**
 * Reads a Server-Sent Events body and yields each event's parsed JSON.
 * Frames look like "event: step.delta\ndata: {...}\n\n"; lines starting with
 * ":" are keep-alives, and the stream ends with "data: [DONE]".
 */
async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (frame) => {
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      // An overloaded backend can emit a bare JSON error instead of an SSE frame.
      else if (line.startsWith('{')) data.push(line);
    }
    if (data.length === 0) return null;
    const text = data.join('\n');
    if (text === '[DONE]') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const event = parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event) yield event;
    }
  }
  const last = parse(buffer);
  if (last) yield last;
}

/**
 * Streams an answer.  `onText` receives each text delta as it arrives; the
 * returned promise resolves with the complete answer and token usage.
 * Aborting `signal` (the browser went away) cancels the upstream request.
 */
async function streamChat({ system, input, signal, onText }) {
  assertConfigured();
  let text = '';

  try {
    return await withModelFallback(
      async (model) => {
        // Watchdog: cancels this attempt if the model goes quiet.  It is re-armed
        // on every event, with a shorter fuse until the model starts working.
        const watchdog = new AbortController();
        let timer;
        const arm = (ms) => {
          clearTimeout(timer);
          timer = setTimeout(() => watchdog.abort(), ms);
        };
        const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;

        let final = null;
        try {
          arm(FIRST_OUTPUT_TIMEOUT_MS);
          const response = await postInteraction(
            {
              model,
              input,
              system_instruction: system,
              // How much the model reasons before answering; "low" keeps chat responsive.
              generation_config: { thinking_level: env.geminiThinkingLevel },
              store: false,
              stream: true,
            },
            combined,
          );

          for await (const event of readEvents(response.body)) {
            if (event.error) throw providerErrorFrom(event);
            if (event.event_type?.startsWith('step.')) arm(STALL_TIMEOUT_MS);

            if (event.event_type === 'step.delta') {
              // Other delta types carry the model's private reasoning; only text is the answer.
              if (event.delta?.type === 'text' && event.delta.text) {
                text += event.delta.text;
                onText?.(event.delta.text);
              }
            } else if (event.event_type === 'interaction.completed') {
              final = event.interaction;
            }
          }
        } catch (error) {
          // The watchdog fired (not the caller): report it as an unresponsive model.
          if (watchdog.signal.aborted && !signal?.aborted) {
            throw new ProviderError(504, `${model} stopped responding.`, { code: 'deadline_exceeded' });
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }

        return {
          text,
          model: final?.model ?? model,
          // completed | incomplete (hit a limit or was blocked) | failed
          stopReason: final?.status ?? 'completed',
          usage: usageOf(final),
        };
      },
      // Once part of an answer is on the user's screen, starting over with another model would garble it.
      { canFallBack: () => text === '' },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw toLlmError(error);
  }
}

/**
 * One-shot call that returns JSON constrained to `jsonSchema` (structured
 * output), then validated with the zod `schema`.  Returns null when the model
 * produced nothing usable.
 */
async function generateStructured({ system, prompt, schema, jsonSchema }) {
  assertConfigured();
  let interaction;
  try {
    interaction = await withModelFallback(async (model) => {
      const response = await postInteraction(
        {
          model,
          input: prompt,
          system_instruction: system,
          generation_config: { thinking_level: 'low' },
          response_format: { type: 'text', mime_type: 'application/json', schema: jsonSchema },
          store: false,
        },
        AbortSignal.timeout(UNARY_TIMEOUT_MS),
      ).catch((error) => {
        // A timeout here is also a reason to try the next model.
        if (error?.name === 'TimeoutError') throw new ProviderError(504, `${model} stopped responding.`, { code: 'deadline_exceeded' });
        throw error;
      });
      return response.json();
    });
  } catch (error) {
    throw toLlmError(error);
  }

  // The answer is the text of the model_output step(s); thought steps are skipped.
  const raw = (interaction.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const llm = { streamChat, generateStructured };
