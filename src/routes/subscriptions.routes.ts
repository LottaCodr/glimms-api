import { Router, Request } from 'express';
import { z } from 'zod';
import { subscriptionsService } from '../services/subscriptions.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';

const router = Router();

const checkoutSchema = z.object({
  priceId: z.string().min(1),
});

/** GET /api/subscriptions/me */
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const sub = await subscriptionsService.getByUserId(req.user!.sub);
  res.json(sub);
});

/** POST /api/subscriptions/checkout */
router.post('/checkout', requireAuth, validateBody(checkoutSchema), async (req: AuthRequest, res) => {
  const { priceId } = req.body;
  const session = await subscriptionsService.createCheckoutSession(req.user!.sub, priceId);
  res.json(session);
});

/** POST /api/subscriptions/webhook  (called by Stripe — raw body) */
router.post('/webhook', async (req: Request, res) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) {
    res.status(400).json({ error: 'Missing Stripe signature', code: 'MISSING_SIGNATURE' });
    return;
  }
  const result = await subscriptionsService.handleWebhook(req.body as Buffer, sig);
  res.json(result);
});

export default router;
export { router as subscriptionsRouter };
