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

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error',   (err) => logger.error({ err }, 'Redis error'));

export async function connectRedis() {
  await redis.connect();
}
