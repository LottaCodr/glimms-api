import { Router } from 'express';
import { z } from 'zod';
import { designSessionsService } from '../services/designSessions.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { scanLimiter } from '../middleware/rateLimiter.middleware';

const router = Router();

// POST /v1/design-sessions — create a session + upload plan
const createSchema = z.object({
  vertical: z.enum(['wardrobe','room','garden']),
  occasion: z.string().optional(),
  culture: z.string().optional(),
  climate: z.object({
    temperature_c: z.number().optional(),
    humidity: z.number().optional(),
  }).optional(),
  preferences: z.object({
    styles: z.array(z.string()).optional(),
    excluded_labels: z.array(z.string()).optional(),
    coverage: z.string().optional(),
    budget: z.any().optional(),
  }).optional(),
  imageCount: z.number().int().min(1).max(5).optional(),
});

router.post('/', requireAuth, scanLimiter, validateBody(createSchema), async (req: AuthRequest, res) => {
  const result = await designSessionsService.createSession(req.user!.sub, req.body);
  res.status(201).json(result);
});

// POST /v1/design-sessions/:session_id/images/complete
const completeSchema = z.object({
  image_ids: z.array(z.string().min(1)).min(1).max(5),
});

router.post('/:session_id/images/complete', requireAuth, validateBody(completeSchema), async (req: AuthRequest, res) => {
  const { session_id } = req.params;
  const { image_ids } = req.body;
  const result = await designSessionsService.completeImages(session_id, req.user!.sub, image_ids);
  res.json(result);
});

// GET /v1/design-sessions/:session_id — stable status model per guide §3.4
router.get('/:session_id', requireAuth, async (req: AuthRequest, res) => {
  const result = await designSessionsService.getSession(req.params.session_id, req.user!.sub);
  res.json(result);
});

// GET /v1/design-sessions — list own sessions
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const result = await designSessionsService.listSessions(req.user!.sub, { page, limit });
  res.json(result);
});

// DELETE /v1/design-sessions/:session_id — cancel
router.delete('/:session_id', requireAuth, async (req: AuthRequest, res) => {
  const result = await designSessionsService.cancelSession(req.params.session_id, req.user!.sub);
  res.json(result);
});

export default router;
