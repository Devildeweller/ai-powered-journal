import { Router } from 'express';
import { z } from 'zod';
import { aiLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import * as chat from '../services/chat.js';
import { LlmError, llm } from '../services/llm.js';
import { enqueueChatExtraction } from '../services/memory.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { todayIso } from '../utils/temporal.js';
import { clientToday, idParams } from './schemas.js';

export const conversationsRouter = Router();
export const chatRouter = Router();

// ----------------------------------------------------------- conversations --

conversationsRouter.get('/', async (req, res) => {
  res.json({ conversations: await chat.listConversations(req.user.id) });
});

conversationsRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const conversation = await chat.getConversation(req.user.id, req.valid.params.id);
  if (!conversation) throw ApiError.notFound('Conversation not found.');
  res.json({ conversation, messages: await chat.getMessages(conversation.id) });
});

conversationsRouter.patch(
  '/:id',
  validate({ params: idParams, body: z.object({ title: z.string().trim().min(1).max(120) }) }),
  async (req, res) => {
    const conversation = await chat.renameConversation(req.user.id, req.valid.params.id, req.valid.body.title);
    if (!conversation) throw ApiError.notFound('Conversation not found.');
    res.json({ conversation });
  },
);

conversationsRouter.delete('/:id', validate({ params: idParams }), async (req, res) => {
  const deleted = await chat.deleteConversation(req.user.id, req.valid.params.id);
  if (!deleted) throw ApiError.notFound('Conversation not found.');
  res.status(204).end();
});

// -------------------------------------------------------------------- chat --

const chatBody = z.object({
  message: z.string().trim().min(1, 'Message is empty.').max(4000, 'Messages can be at most 4,000 characters.'),
  conversationId: z.uuid().optional(),
  today: clientToday,
});

/**
 * POST /api/chat — answers over Server-Sent Events.
 *
 * Event sequence:
 *   conversation  { conversation, isNew, userMessage }
 *   status        { stage: 'retrieving' | 'generating' }
 *   sources       { entries, memories, range }      what retrieval found
 *   delta         { text }                          repeated, the answer as it is written
 *   done          { message }                       the stored assistant message
 *   error         { message }                       instead of done, on failure
 */
chatRouter.post('/', aiLimiter, validate({ body: chatBody }), async (req, res) => {
  const userId = req.user.id;
  const { message, conversationId } = req.valid.body;
  const today = req.valid.body.today ?? todayIso();

  // Everything that can fail with a normal HTTP status happens before the stream opens.
  let conversation;
  let isNew = false;
  if (conversationId) {
    conversation = await chat.getConversation(userId, conversationId);
    if (!conversation) throw ApiError.notFound('Conversation not found.');
  } else {
    conversation = await chat.createConversation(userId, chat.titleFromMessage(message));
    isNew = true;
  }
  const history = await chat.getMessages(conversation.id);
  const userMessage = await chat.addMessage({ conversationId: conversation.id, userId, role: 'user', content: message });

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx-style proxies not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Comment lines keep idle proxies from closing the connection while the model thinks.
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': keep-alive\n\n'), 15_000);

  // If the browser goes away (tab closed, "stop" pressed), cancel the model call.
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) abort.abort();
  });

  let answer = '';
  let sources = null;
  try {
    send('conversation', { conversation, isNew, userMessage });
    send('status', { stage: 'retrieving' });

    const previousUserMessage = [...history].reverse().find((item) => item.role === 'user')?.content;
    const context = await chat.buildContext({ userId, message, previousUserMessage, today });
    sources = chat.summariseSources(context);
    send('sources', sources);
    send('status', { stage: 'generating' });

    const started = Date.now();
    const result = await llm.streamChat({
      system: chat.SYSTEM_PROMPT,
      input: chat.buildInput(history, chat.renderContext(context), message),
      signal: abort.signal,
      onText: (delta) => {
        answer += delta;
        send('delta', { text: delta });
      },
    });

    // An empty answer means the model stopped early or declined.
    const content = result.text.trim() || "I couldn't put an answer together this time. Could you try asking it another way?";

    const saved = await chat.addMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content,
      sources,
      meta: {
        model: result.model,
        stopReason: result.stopReason,
        usage: result.usage,
        retrievalMs: context.retrievalMs,
        generationMs: Date.now() - started,
      },
    });
    send('done', { message: saved });

    enqueueChatExtraction({ userId, conversationId: conversation.id, userText: message, assistantText: content, today });
  } catch (error) {
    if (abort.signal.aborted) {
      // Keep whatever was already written so the conversation stays coherent.
      if (answer.trim()) {
        await chat
          .addMessage({
            conversationId: conversation.id,
            userId,
            role: 'assistant',
            content: answer.trim(),
            sources,
            meta: { interrupted: true },
          })
          .catch((saveError) => logger.warn({ err: saveError }, 'could not save interrupted answer'));
      }
    } else {
      logger.error({ err: error }, 'chat request failed');
      send('error', {
        message: error instanceof LlmError ? error.message : 'Something went wrong while answering. Please try again.',
      });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    res.end();
  }
});
