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

/**
 * Commands issued while an ioredis client is in lazy mode start its connection
 * automatically. Some modules (notably rate-limit-redis and BullMQ) issue those
 * commands during import, so the client can already be connecting by the time
 * server bootstrap reaches connectRedis(). Calling connect() in that state
 * throws "Redis is already connecting/connected"; wait for that connection
 * instead.
 */
function waitForRedisReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      redis.removeListener('ready', onReady);
      redis.removeListener('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(
        lastSocketError instanceof Error
          ? lastSocketError
          : new Error('Redis connection closed before becoming ready'),
      );
    };

    redis.once('ready', onReady);
    redis.once('end', onEnd);

    // Status changes synchronously but events are emitted on the next tick.
    // Re-checking here also makes this safe if that implementation changes.
    if (redis.status === 'ready') onReady();
    else if (redis.status === 'end') onEnd();
  });
}

async function establishRedisConnection(): Promise<void> {
  if (redis.status === 'ready') return;

  // A lazy client begins in "wait". "end" is also reconnectable via an
  // explicit connect() call. Every other non-ready state represents an active
  // initial connection or retry that we must not duplicate.
  if (redis.status === 'wait' || redis.status === 'end') {
    await redis.connect();
    return;
  }

  await waitForRedisReady();
}

let connectionAttempt: Promise<void> | null = null;

export function connectRedis(): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  if (connectionAttempt) return connectionAttempt;

  connectionAttempt = establishRedisConnection().catch((err) => {
    if (isConnectionRefused(err) || isConnectionRefused(lastSocketError)) {
      logger.error(
        `Could not connect to Redis at ${config.redis.url}. ` +
          'Redis is required (queues, rate limiting, caching). Start it with ' +
          '`npm run services:up` (Docker Desktop), install Redis/Memurai locally, ' +
          'or point REDIS_URL at a running instance — then restart `npm run dev`.',
      );
    }
    throw err;
  });

  const attempt = connectionAttempt;
  const clearAttempt = () => {
    if (connectionAttempt === attempt) connectionAttempt = null;
  };
  // Supply both handlers so this housekeeping promise can never become an
  // unhandled rejection when the connection attempt fails.
  void attempt.then(clearAttempt, clearAttempt);

  return attempt;
}
