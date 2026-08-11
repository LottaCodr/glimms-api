import { Router, Request } from 'express';
import { subscriptionsService } from '../services/subscriptions.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

/** GET /api/subscriptions/me */
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const sub = await subscriptionsService.getByUserId(req.user!.sub);
  res.json(sub);
});

/** POST /api/subscriptions/checkout */
router.post('/checkout', requireAuth, async (req: AuthRequest, res) => {
  const { priceId } = req.body;
  const session = await subscriptionsService.createCheckoutSession(req.user!.sub, priceId);
  res.json(session);
});

/** POST /api/subscriptions/webhook  (called by Stripe — raw body) */
router.post('/webhook', async (req: Request, res) => {
  const sig = req.headers['stripe-signature'] as string;
  const result = await subscriptionsService.handleWebhook(req.body, sig);
  res.json(result);
});

export default router;
