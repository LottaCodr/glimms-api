import { Router } from 'express';
import { z } from 'zod';
import { usersService } from '../services/users.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';

const router = Router();

const updateUserSchema = z.object({
  name:      z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().optional(),
});

const preferencesSchema = z.object({
  occupation:  z.string().optional(),
  styleGoals:  z.array(z.string()).optional(),
  occasions:   z.array(z.string()).optional(),
  culturalCtx: z.string().optional(),
  location:    z.object({
    lat:     z.number(),
    lon:     z.number(),
    city:    z.string().optional(),
    country: z.string().optional(),
  }).optional(),
});

// GET /api/users/me
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const user = await usersService.findById(req.user!.sub);
  res.json(user);
});

// PATCH /api/users/me
router.patch('/me', requireAuth, validateBody(updateUserSchema), async (req: AuthRequest, res) => {
  const user = await usersService.update(req.user!.sub, req.body);
  res.json(user);
});

// DELETE /api/users/me
router.delete('/me', requireAuth, async (req: AuthRequest, res) => {
  const result = await usersService.deactivate(req.user!.sub);
  res.json(result);
});

// GET /api/users/me/preferences
router.get('/me/preferences', requireAuth, async (req: AuthRequest, res) => {
  const prefs = await usersService.getPreferences(req.user!.sub);
  res.json(prefs ?? {});
});

// PUT /api/users/me/preferences
router.put('/me/preferences', requireAuth, validateBody(preferencesSchema), async (req: AuthRequest, res) => {
  const prefs = await usersService.upsertPreferences(req.user!.sub, req.body);
  res.json(prefs);
});

export default router;
