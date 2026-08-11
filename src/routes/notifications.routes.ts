import { Router } from 'express';
import { z } from 'zod';
import { notificationsService } from '../services/notifications.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';

const router = Router();

const registerTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

/** POST /api/notifications/device-token */
router.post('/device-token', requireAuth, validateBody(registerTokenSchema), async (req: AuthRequest, res) => {
  const result = await notificationsService.registerDevice(req.user!.sub, req.body.token, req.body.platform);
  res.status(201).json(result);
});

export default router;
