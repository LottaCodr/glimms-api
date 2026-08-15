import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

export const redis = new Redis(config.redis.url, {
  lazyConnect: true,
  retryStrategy: (times) => {
    if (times > 10) return null;
    return Math.min(times * 150, 3000);
  },
  maxRetriesPerRequest: 3,
});

// ioredis emits 'error' on *every* failed reconnect attempt — log once per
// outage instead of flooding the console with identical AggregateErrors.
let errorLoggedForOutage = false;
// When the retry strategy gives up, connect() rejects with a generic
// "Connection is closed." — keep the last real socket error around so
// connectRedis() can still tell *why* it failed.
let lastSocketError: unknown = null;

redis.on('connect', () => {
  errorLoggedForOutage = false;
  lastSocketError = null;
  logger.info('Redis connected');
});
redis.on('error', (err) => {
  lastSocketError = err;
  if (errorLoggedForOutage) return;
  errorLoggedForOutage = true;
  logger.error({ err }, 'Redis error');
});

function isConnectionRefused(err: unknown): boolean {
  const e = err as { code?: string; errors?: Array<{ code?: string }> };
  return (
    e?.code === 'ECONNREFUSED' ||
    (Array.isArray(e?.errors) && e.errors.some((inner) => inner?.code === 'ECONNREFUSED'))
  );
}

export async function connectRedis() {
  try {
    await redis.connect();
  } catch (err) {
    if (isConnectionRefused(err) || isConnectionRefused(lastSocketError)) {
      logger.error(
        `Could not connect to Redis at ${config.redis.url}. ` +
          'Redis is required (queues, rate limiting, caching). Start it with ' +
          '`npm run services:up` (Docker Desktop), install Redis/Memurai locally, ' +
          'or point REDIS_URL at a running instance — then restart `npm run dev`.',
      );
    }
    throw err;
  }
}
