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

    async function canAccess(id: string, kind: 'job' | 'session'): Promise<boolean> {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        socket.emit('error', { message: `Invalid ${kind} id`, jobId: id, sessionId: id });
        return false;
      }
      try {
        if (kind === 'job') {
          const { DesignJob } = await import('../models');
          const job = await DesignJob.findById(id).select('userId').lean();
          if (!job) { socket.emit('error', { message: 'Job not found', jobId: id }); return false; }
          if (job.userId.toString() !== user.sub) { socket.emit('error', { message: 'Not authorized for this job', jobId: id }); return false; }
        } else {
          const { DesignSession } = await import('../models/DesignSession');
          const sess = await DesignSession.findById(id).select('userId').lean();
          if (!sess) { socket.emit('error', { message: 'Session not found', sessionId: id }); return false; }
          if ((sess as any).userId.toString() !== user.sub) { socket.emit('error', { message: 'Not authorized for this session', sessionId: id }); return false; }
        }
      } catch (err: any) {
        logger.warn({ err: err.message, id, kind }, 'WS subscribe ownership check failed');
        if (config.nodeEnv === 'production') {
          socket.emit('error', { message: 'Unable to verify ownership', id });
          return false;
        }
      }
      return true;
    }

    // Legacy job rooms
    socket.on('subscribe:job', async (jobId: string) => {
      if (typeof jobId !== 'string' || !jobId) return;
      if (!(await canAccess(jobId, 'job'))) return;
      socket.join(`job:${jobId}`);
      socket.emit('subscribed', { jobId });
      logger.debug({ jobId, socketId: socket.id, userId: user.sub }, 'Client subscribed to job room');
    });
    socket.on('unsubscribe:job', (jobId: string) => {
      if (typeof jobId !== 'string' || !jobId) return;
      socket.leave(`job:${jobId}`);
      socket.emit('unsubscribed', { jobId });
    });

    // v1 design-sessions rooms (guide §3.4 — polling/WS)
    socket.on('subscribe:session', async (sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return;
      if (!(await canAccess(sessionId, 'session'))) return;
      socket.join(`session:${sessionId}`);
      // Also join legacy job room for compatibility (worker emits to both)
      socket.join(`job:${sessionId}`);
      socket.emit('subscribed', { sessionId });
      logger.debug({ sessionId, socketId: socket.id, userId: user.sub }, 'Client subscribed to session room');
    });
    socket.on('unsubscribe:session', (sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return;
      socket.leave(`session:${sessionId}`);
      socket.leave(`job:${sessionId}`);
      socket.emit('unsubscribed', { sessionId });
    });
    // Aliases for guide naming: subscribe:design-session
    socket.on('subscribe:design-session', async (sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return;
      if (!(await canAccess(sessionId, 'session'))) return;
      socket.join(`session:${sessionId}`);
      socket.join(`job:${sessionId}`);
      socket.emit('subscribed', { sessionId });
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
