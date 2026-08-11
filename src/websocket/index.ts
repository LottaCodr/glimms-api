import { Server as HTTPServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AuthUser } from '../middleware/auth.middleware';

export function createWebSocketServer(httpServer: HTTPServer): IOServer {
  const io = new IOServer(httpServer, {
    cors: {
      origin:      config.cors.allowedOrigins,
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    transports:    ['websocket', 'polling'],
    pingTimeout:   60_000,
    pingInterval:  25_000,
  });

  // ── Auth middleware on every WS connection ────────────────────────────────
  io.use((socket, next) => {
    // Token can come from auth header or from handshake auth object (mobile)
    const token =
      socket.handshake.auth?.token ??
      (socket.handshake.headers.authorization as string | undefined)?.replace('Bearer ', '');

    if (!token) {
      return next(new Error('Authentication token required'));
    }

    try {
      socket.data.user = jwt.verify(token, config.jwt.secret) as AuthUser;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const user: AuthUser = socket.data.user;
    logger.debug({ userId: user.sub, socketId: socket.id }, 'WS client connected');

    // Client subscribes to a specific design job room — with ownership check
    socket.on('subscribe:job', async (jobId: string) => {
      if (typeof jobId !== 'string' || !jobId) return;
      if (!mongoose.Types.ObjectId.isValid(jobId)) {
        socket.emit('error', { message: 'Invalid job id', jobId });
        return;
      }
      // Ownership check: ensure job belongs to the authenticated user
      try {
        const { DesignJob } = await import('../models');
        const job = await DesignJob.findById(jobId).select('userId').lean();
        if (!job) {
          socket.emit('error', { message: 'Job not found', jobId });
          return;
        }
        if (job.userId.toString() !== user.sub) {
          socket.emit('error', { message: 'Not authorized for this job', jobId });
          return;
        }
      } catch (err: any) {
        logger.warn({ err: err.message, jobId }, 'WS subscribe ownership check failed');
        // Fail open in dev if DB unavailable, but emit warning
        if (config.nodeEnv === 'production') {
          socket.emit('error', { message: 'Unable to verify job ownership', jobId });
          return;
        }
      }
      socket.join(`job:${jobId}`);
      socket.emit('subscribed', { jobId });
      logger.debug({ jobId, socketId: socket.id, userId: user.sub }, 'Client subscribed to job room');
    });

    socket.on('unsubscribe:job', (jobId: string) => {
      if (typeof jobId !== 'string' || !jobId) return;
      socket.leave(`job:${jobId}`);
      socket.emit('unsubscribed', { jobId });
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: user.sub, reason }, 'WS client disconnected');
    });

    socket.on('error', (err) => {
      logger.warn({ err: err.message, userId: user.sub }, 'WS socket error');
    });
  });

  return io;
}
