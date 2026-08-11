import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from './logger';

/**
 * Mongoose 9 connection setup.
 *
 * Key Mongoose 9 notes:
 *  - strictQuery defaults to false (no need to set it manually)
 *  - No more useNewUrlParser / useUnifiedTopology options (removed)
 *  - sanitizeFilter guards against NoSQL injection ($where, $nor etc) — GHSA-wpg9-53fq-2r8h
 */

mongoose.set('sanitizeFilter', true);

mongoose.connection.on('connected', () => {
  logger.info('MongoDB connected');
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error({ err }, 'MongoDB connection error');
});

export async function connectDB(): Promise<void> {
  await mongoose.connect(config.mongodb.uri, {
    // Connection pool — tune for your workload
    maxPoolSize:     10,
    minPoolSize:     2,
    // How long to wait for a connection from the pool
    waitQueueTimeoutMS: 5000,
    // How long to wait for a new connection to be established
    connectTimeoutMS: 10000,
    // How long to wait for a socket operation (query)
    socketTimeoutMS: 45000,
    // Retry writes on transient failures (replica sets / Atlas)
    retryWrites: true,
    // Auto-create indexes in development (disable in production for performance)
    autoIndex: config.isDev,
  });
  // Ensure indexes are built in prod as well (explicit sync)
  if (!config.isDev) {
    try {
      await mongoose.connection.syncIndexes();
      logger.info('MongoDB indexes synced');
    } catch (e) {
      logger.warn({ err: e }, 'Index sync failed (non-fatal)');
    }
  }
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected cleanly');
}

export { mongoose };
