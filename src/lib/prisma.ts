import { PrismaClient } from '@prisma/client';
import { config } from '../config';
import { logger } from './logger';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: config.isDev
      ? [{ level: 'query', emit: 'event' }, { level: 'error', emit: 'stdout' }]
      : [{ level: 'error', emit: 'stdout' }],
  });

if (config.isDev) {
  global.__prisma = prisma;
  (prisma as any).$on('query', (e: { query: string; duration: number }) => {
    if (e.duration > 200) {
      logger.warn({ query: e.query, duration: e.duration }, 'Slow query detected');
    }
  });
}

export async function connectDB() {
  await prisma.$connect();
  logger.info('PostgreSQL connected');
}

export async function disconnectDB() {
  await prisma.$disconnect();
  logger.info('PostgreSQL disconnected');
}
