import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { validateBody } from '../middleware/validate.middleware';
import { authLimiter } from '../middleware/rateLimiter.middleware';

const router = Router();

const registerSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name:     z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// POST /api/auth/register
router.post('/register', authLimiter, validateBody(registerSchema), async (req, res) => {
  const tokens = await authService.register(req.body);
  res.status(201).json(tokens);
});

// POST /api/auth/login
router.post('/login', authLimiter, validateBody(loginSchema), async (req, res) => {
  const tokens = await authService.login(req.body);
  res.json(tokens);
});

// POST /api/auth/refresh
router.post('/refresh', validateBody(refreshSchema), async (req, res) => {
  const tokens = await authService.refresh(req.body.refreshToken);
  res.json(tokens);
});

// POST /api/auth/logout
router.post('/logout', validateBody(refreshSchema), async (req, res) => {
  const result = await authService.logout(req.body.refreshToken);
  res.json(result);
});

export default router;
