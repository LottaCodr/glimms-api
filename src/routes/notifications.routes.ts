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

/** DELETE /api/notifications/device-token — remove token (logout device) */
router.delete('/device-token', requireAuth, validateBody(registerTokenSchema), async (req: AuthRequest, res) => {
  const { DeviceToken } = await import('../models');
  await DeviceToken.deleteOne({ token: req.body.token, userId: req.user!.sub });
  res.json({ message: 'Device token removed' });
});

export default router;
export { router as notificationsRouter };
