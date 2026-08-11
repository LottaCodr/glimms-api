import 'express-async-errors';
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';

import { config } from './config';
import { logger } from './lib/logger';
import { generalLimiter } from './middleware/rateLimiter.middleware';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.middleware';

// Routes
import authRoutes          from './routes/auth.routes';
import usersRoutes         from './routes/users.routes';
import catalogRoutes       from './routes/catalog.routes';
import scansRoutes         from './routes/scans.routes';
import { designsRouter }   from './routes/designs.routes';
import {
  subscriptionsRouter,
  notificationsRouter,
  analyticsRouter,
} from './routes/misc.routes';

export function createApp(): Express {
  const app = express();

  // ── Trust proxy (behind nginx / AWS ALB) ──────────────────────────────────
  app.set('trust proxy', 1);

  // ── Security headers ──────────────────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: false,   // not needed for an API-only server
  }));

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (native mobile apps, curl)
      if (!origin || config.cors.allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials:     true,
    methods:         ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders:  ['Authorization', 'Content-Type', 'X-Requested-With'],
  }));

  // ── Response compression ──────────────────────────────────────────────────
  app.use(compression());

  // ── HTTP request logger ───────────────────────────────────────────────────
  app.use(pinoHttp({
    logger,
    customLogLevel: (_req, res) =>
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    redact: ['req.headers.authorization'],
    serializers: {
      req: req => ({
        id:     req.id,
        method: req.method,
        url:    req.url,
        ip:     req.remoteAddress,
      }),
    },
  }));

  // ── Global rate limiter ───────────────────────────────────────────────────
  app.use(generalLimiter);

  // ── Raw body for Stripe webhook — MUST come BEFORE express.json() ─────────
  app.use(
    '/api/subscriptions/webhook',
    express.raw({ type: 'application/json' }),
  );

  // ── Body parsers ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status:  'ok',
      service: 'glimms-api',
      env:     config.nodeEnv,
      ts:      new Date().toISOString(),
    });
  });

  // ── API routes ────────────────────────────────────────────────────────────
  app.use('/api/auth',          authRoutes);
  app.use('/api/users',         usersRoutes);
  app.use('/api/catalog',       catalogRoutes);
  app.use('/api/scans',         scansRoutes);
  app.use('/api/designs',       designsRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/analytics',     analyticsRouter);

  // ── 404 + global error handler (must be last) ─────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
