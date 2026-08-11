import { Router, Request } from 'express';
import { z } from 'zod';
import { subscriptionsService } from '../services/subscriptions.service';
import { notificationsService } from '../services/notifications.service';
import { analyticsService } from '../services/analytics.service';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';

// ── Subscriptions ─────────────────────────────────────────────────────────────

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const sub = await subscriptionsService.getByUserId(req.user!.sub);
  res.json(sub);
});

subscriptionsRouter.post('/checkout', requireAuth, async (req: AuthRequest, res) => {
  const { priceId } = req.body;
  const session = await subscriptionsService.createCheckoutSession(req.user!.sub, priceId);
  res.json(session);
});

// Stripe calls this — needs raw body (registered in app.ts before express.json)
subscriptionsRouter.post('/webhook', async (req: Request, res) => {
  const sig = req.headers['stripe-signature'] as string;
  const result = await subscriptionsService.handleWebhook(req.body as Buffer, sig);
  res.json(result);
});


// ── Notifications ─────────────────────────────────────────────────────────────

export const notificationsRouter = Router();

const registerTokenSchema = z.object({
  token:    z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

notificationsRouter.post(
  '/device-token',
  requireAuth,
  validateBody(registerTokenSchema),
  async (req: AuthRequest, res) => {
    const result = await notificationsService.registerDevice(
      req.user!.sub,
      req.body.token,
      req.body.platform,
    );
    res.status(201).json(result);
  },
);


// ── Analytics ─────────────────────────────────────────────────────────────────

export const analyticsRouter = Router();

const trackSchema = z.object({
  event:      z.string().min(1),
  properties: z.record(z.unknown()).optional(),
});

analyticsRouter.post('/track', optionalAuth, validateBody(trackSchema), async (req: AuthRequest, res) => {
  const result = await analyticsService.track(
    req.user?.sub ?? 'anonymous',
    req.body.event,
    req.body.properties,
  );
  res.json(result);
});

analyticsRouter.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const stats = await analyticsService.getBasicStats(req.user!.sub);
  res.json(stats);
});
