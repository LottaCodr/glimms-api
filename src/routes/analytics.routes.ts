import { Router } from 'express';
import { z } from 'zod';
import { analyticsService } from '../services/analytics.service';
import { optionalAuth, requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';

const router = Router();

const trackSchema = z.object({
  event: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
});

/** POST /api/analytics/track — optional auth (anonymous allowed) */
router.post('/track', optionalAuth, validateBody(trackSchema), async (req: AuthRequest, res) => {
  const result = await analyticsService.track(
    req.user?.sub ?? 'anonymous',
    req.body.event,
    req.body.properties,
  );
  res.json(result);
});

/** GET /api/analytics/me — requires auth, returns per-user stats */
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const stats = await analyticsService.getBasicStats(req.user!.sub);
  res.json(stats);
});

export default router;
export { router as analyticsRouter };
