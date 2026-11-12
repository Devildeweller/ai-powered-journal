import pino from 'pino';
import { env } from '../config/env.js';

function buildOptions() {
  if (env.isTest) return { level: 'silent' };
  if (env.isProduction) return { level: 'info' };
  return {
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname', singleLine: true },
    },
  };
}

export const logger = pino({
  ...buildOptions(),
  // Never let credentials or journal text reach the logs.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    remove: true,
  },
});
