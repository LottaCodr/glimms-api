import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Response, NextFunction } from 'express';
import { redis } from '../lib/redis';
import { config } from '../config';
import { AuthRequest } from './auth.middleware';

// ── General API rate limiter ───────────────────────────────────────────────────

export const generalLimiter = rateLimit({
  windowMs:       config.rateLimit.windowMs,
  max:            config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:  false,
  store: new RedisStore({
    // cast to any to satisfy SendCommandFn typing across ioredis versions
    sendCommand: (...args: string[]) => (redis as any).call(...args),
  } as any),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler: (_req, res) =>
    res.status(429).json({ error: 'Too many requests — please slow down.', code: 'RATE_LIMITED' }),
});

// ── Auth endpoint limiter — prevents brute-force ──────────────────────────────

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  // Tests issue more than 10 auth requests in a single run — don't throttle them
  max: config.nodeEnv === 'test' ? 10_000 : 10,
  store: new RedisStore({
    sendCommand: (...args: string[]) => (redis as any).call(...args),
    prefix: 'auth_rl:',
  } as any),
  keyGenerator: (req) => `auth:${req.ip}`,
  handler: (_req, res) =>
    res.status(429).json({
      error: 'Too many auth attempts. Try again in 15 minutes.',
      code:  'AUTH_RATE_LIMITED',
    }),
});

// ── Per-user daily scan quota ─────────────────────────────────────────────────

export async function scanLimiter(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { sub: userId, tier } = req.user;

  // Pro users are unlimited
  if (tier === 'pro') {
    next();
    return;
  }

  const maxScans = tier === 'premium'
    ? config.stripe.premiumScanLimit
    : config.stripe.freeScanLimit;

  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const key   = `scan_limit:${userId}:${today}`;

  try {
    const results = await redis.multi().incr(key).expire(key, 86400).exec() as any;
    const count   = (results?.[0]?.[1] as number) ?? 0;

    res.setHeader('X-Scan-Count-Today', String(count));
    res.setHeader('X-Scan-Limit',       String(maxScans));
    res.setHeader('X-Scan-Tier',        tier);

    if (count > maxScans) {
      res.status(429).json({
        error:       'Daily scan limit reached',
        scansUsed:   count - 1,
        limit:       maxScans,
        tier,
        upgradeUrl:  'https://app.glimms.ai/upgrade',
        resetsAt:    `${today}T23:59:59Z`,
        code:        'SCAN_LIMIT_REACHED',
      });
      return;
    }

    next();
  } catch (err) {
    // If Redis is down, fail open — don't block scans, just log
    const { logger } = await import('../lib/logger');
    logger.warn({ err }, 'scanLimiter Redis error — allowing request');
    next();
  }
}
