import http from 'http';

import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { connectDB, disconnectDB } from './lib/mongoose';
import { connectRedis, redis } from './lib/redis';
import { createWebSocketServer } from './websocket';
import { startDesignWorker, setIO } from './workers/design.worker';

async function bootstrap() {
  // ── 1. Connect to MongoDB ─────────────────────────────────────────────────
  await connectDB();

  // ── 2. Connect to Redis ───────────────────────────────────────────────────
  await connectRedis();

  // ── 3. Build Express app ──────────────────────────────────────────────────
  const app = createApp();

  // ── 4. Wrap in HTTP server so Socket.IO can share the same port ───────────
  const httpServer = http.createServer(app);

  // ── 5. Attach Socket.IO ───────────────────────────────────────────────────
  const io = createWebSocketServer(httpServer);

  // ── 6. Give the BullMQ worker access to the io instance for WS pushes ─────
  setIO(io);

  // ── 7. Start the design pipeline worker ──────────────────────────────────
  const worker = startDesignWorker();

  // ── 8. Start listening ────────────────────────────────────────────────────
  httpServer.listen(config.port, () => {
    logger.info(
      [
        '',
        '╔══════════════════════════════════════════════╗',
        `║            GLIMMS API — running              ║`,
        `║  Port     : ${String(config.port).padEnd(30)}║`,
        `║  Env      : ${config.nodeEnv.padEnd(30)}║`,
        `║  DB       : MongoDB (Mongoose 9)             ║`,
        `║  Queue    : BullMQ / Redis                   ║`,
        `║  Realtime : Socket.IO                        ║`,
        '╚══════════════════════════════════════════════╝',
      ].join('\n'),
    );
  });

  // ── 9. Graceful shutdown ──────────────────────────────────────────────────
  async function shutdown(signal: string) {
    logger.info(`${signal} received — shutting down gracefully`);

    // Stop accepting new connections
    httpServer.close(async () => {
      try {
        await worker.close();     // drain in-flight jobs
        await disconnectDB();     // close Mongoose connection
        await redis.quit();       // close Redis connection
        logger.info('Server shut down cleanly ✅');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });

    // Force exit after 15 s if clean shutdown hangs
    setTimeout(() => {
      logger.error('Forced exit after 15 s timeout');
      process.exit(1);
    }, 15_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Catch unhandled rejections so the process doesn't silently die
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
}

bootstrap().catch(err => {
  console.error('Fatal: failed to start server', err);
  process.exit(1);
});
