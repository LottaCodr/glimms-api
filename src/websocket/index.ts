import { Server as HTTPServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
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

    // Client subscribes to a specific design job room
    socket.on('subscribe:job', (jobId: string) => {
      if (typeof jobId !== 'string' || !jobId) return;
      socket.join(`job:${jobId}`);
      socket.emit('subscribed', { jobId });
      logger.debug({ jobId, socketId: socket.id }, 'Client subscribed to job room');
    });

    socket.on('unsubscribe:job', (jobId: string) => {
      socket.leave(`job:${jobId}`);
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
