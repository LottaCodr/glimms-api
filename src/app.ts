import 'express-async-errors';
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';

import { config } from './config';
import { logger } from './lib/logger';
import { redis } from './lib/redis';
import { generalLimiter } from './middleware/rateLimiter.middleware';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.middleware';

// Routes — legacy API (kept for backward compatibility)
import authRoutes          from './routes/auth.routes';
import usersRoutes         from './routes/users.routes';
import catalogRoutes       from './routes/catalog.routes';
import scansRoutes         from './routes/scans.routes';
import { designsRouter }   from './routes/designs.routes';
import subscriptionsRouter from './routes/subscriptions.routes';
import notificationsRouter from './routes/notifications.routes';
import analyticsRouter     from './routes/analytics.routes';
// Routes — v1 design-sessions (per backend implementation guide §3)
import designSessionsRouter from './routes/designSessions.routes';

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
    allowedHeaders:  ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Correlation-ID', 'X-Request-ID'],
    exposedHeaders:  ['X-Request-Id'],
  }));

  // ── Response compression ──────────────────────────────────────────────────
  app.use(compression());

  // ── HTTP request logger ───────────────────────────────────────────────────
  app.use((pinoHttp as any)({
    logger,
    customLogLevel: (_req: any, res: any) =>
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    redact: ['req.headers.authorization', 'req.headers["x-correlation-id"]'],
    serializers: {
      req: (req: any) => ({
        id:     req.id,
        method: req.method,
        url:    req.url,
        ip:     req.remoteAddress,
      }),
    },
    genReqId: (req: any) => (req.headers['x-request-id'] as string) || (req.headers['x-correlation-id'] as string) || undefined as any,
  }));

  // ── Global rate limiter ───────────────────────────────────────────────────
  // Skip health so k8s probes are not rate-limited
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    return generalLimiter(req, res, next);
  });

  // ── Raw body for Stripe webhook — MUST come BEFORE express.json() ─────────
  app.use(
    '/api/subscriptions/webhook',
    express.raw({ type: 'application/json' }),
  );

  // ── Body parsers ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // ── Health check (liveness + dependency readiness) ───────────────────────
  app.get('/health', async (_req, res) => {
    const checks: Record<string, string> = {};
    const services: Record<string, any> = {};
    // Mongo
    try {
      const state = mongoose.connection.readyState; // 0=disconnected,1=connected,2=connecting,3=disconnecting
      checks.mongodb = state === 1 ? 'ok' : `state:${state}`;
    } catch {
      checks.mongodb = 'error';
    }
    // Redis (best-effort)
    try {
      const pong = await redis.ping();
      checks.redis = pong === 'PONG' ? 'ok' : pong;
    } catch {
      checks.redis = 'unavailable';
    }
    // AI services readiness (optional — check only if not in test)
    if ((config.nodeEnv as string) !== 'test') {
      // We expose readiness via separate endpoint /health/ready if needed; keep /health lightweight
      services.ai = 'use GET /health/ready for AI service readiness';
    }

    const healthy = checks.mongodb === 'ok';
    res.status(healthy ? 200 : 503).json({
      status:  healthy ? 'ok' : 'degraded',
      service: 'glimms-api',
      env:     config.nodeEnv,
      checks,
      services,
      ts:      new Date().toISOString(),
      uptime:  process.uptime(),
    });
  });

  // AI services readiness (per guide §4: liveness vs readiness, model_loaded)
  app.get('/health/ready', async (_req, res) => {
    const { aiClient } = await import('./lib/aiClient');
    const { summarizeReadiness } = await import('./lib/readiness');

    // The gateway's own /health is authoritative about which services are
    // running fallbacks, so prefer its production_ready + degradations.
    let productionReady: boolean | null = null;
    let degradations: Array<{ service: string; reason: string }> = [];
    if (config.aiGatewayUrl) {
      try {
        const health = await aiClient.gatewayHealth();
        productionReady = health.production_ready ?? null;
        degradations    = health.degradations ?? [];
      } catch {
        productionReady = null; // reported per-service below
      }
    }

    const aiChecks = await aiClient.checkReadiness();
    const { status, ready } = summarizeReadiness(aiChecks, { allowDegraded: config.aiAllowDegraded });

    res.status(ready ? 200 : 503).json({
      status,
      ready,
      gateway: config.aiGatewayUrl ?? null,
      // false = the AI tier is returning prototype output, not real model results
      production_ready: productionReady,
      degradations,
      checks:  aiChecks,
      ts:      new Date().toISOString(),
    });
  });

  // ── API routes — legacy (deprecated but kept) ─────────────────────────────
  app.use('/api/auth',          authRoutes);
  app.use('/api/users',         usersRoutes);
  app.use('/api/catalog',       catalogRoutes);
  app.use('/api/scans',         scansRoutes);
  app.use('/api/designs',       designsRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/analytics',     analyticsRouter);

  // ── v1 API — per backend implementation guide (preferred) ─────────────────
  app.use('/v1/design-sessions', designSessionsRouter);
  // Also expose health under v1
  app.get('/v1/health', (_req, res) => res.redirect(307, '/health'));

  // ── 404 + global error handler (must be last) ─────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
