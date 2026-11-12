import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import authRouter from './routes/auth.js';
import { chatRouter, conversationsRouter } from './routes/chat.js';
import entriesRouter from './routes/entries.js';
import { attachmentsRouter, insightsRouter, memoriesRouter, metaRouter } from './routes/misc.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Render (and the Vercel proxy in front of it) terminate TLS and forward
  // the client address; trusting one hop makes req.ip and secure cookies work.
  if (env.isProduction) app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      // Log the route and outcome only: never bodies, which hold journal text.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.clientOrigins, credentials: true }));
  app.use(
    compression({
      // Compressing would buffer the token stream and defeat streaming.
      filter: (req, res) => (req.path.startsWith('/api/chat') ? false : compression.filter(req, res)),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', apiLimiter);
  app.use('/api', metaRouter);
  app.use('/api/auth', authRouter);

  // Everything below requires a signed-in user.
  app.use('/api/entries', requireAuth, entriesRouter);
  app.use('/api/conversations', requireAuth, conversationsRouter);
  app.use('/api/chat', requireAuth, chatRouter);
  app.use('/api/memories', requireAuth, memoriesRouter);
  app.use('/api/attachments', requireAuth, attachmentsRouter);
  app.use('/api/insights', requireAuth, insightsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
