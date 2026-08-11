// ── designs.routes.ts ─────────────────────────────────────────────────────────

import { Router } from 'express';
import { z } from 'zod';
import { designsService } from '../services/designs.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';

const designsRouter = Router();

const saveDesignSchema = z.object({
  jobId:       z.string().min(1),
  title:       z.string().optional(),
  items:       z.array(z.record(z.unknown())),
  mockupUrl:   z.string().url().optional(),
  explanation: z.string().optional(),
  tips:        z.array(z.string()).optional(),
  score:       z.number().min(0).max(1).optional(),
});

// GET /api/designs/jobs
designsRouter.get('/jobs', requireAuth, async (req: AuthRequest, res) => {
  const jobs = await designsService.listJobs(req.user!.sub);
  res.json(jobs);
});

// GET /api/designs/jobs/:id
designsRouter.get('/jobs/:id', requireAuth, async (req: AuthRequest, res) => {
  const job = await designsService.getJob(req.params.id, req.user!.sub);
  res.json(job);
});

// GET /api/designs/saved
designsRouter.get('/saved', requireAuth, async (req: AuthRequest, res) => {
  const designs = await designsService.getSavedDesigns(req.user!.sub);
  res.json(designs);
});

// POST /api/designs/saved
designsRouter.post('/saved', requireAuth, validateBody(saveDesignSchema), async (req: AuthRequest, res) => {
  const design = await designsService.saveDesign(req.user!.sub, req.body.jobId, req.body);
  res.status(201).json(design);
});

// PATCH /api/designs/saved/:id/favorite
designsRouter.patch('/saved/:id/favorite', requireAuth, async (req: AuthRequest, res) => {
  const design = await designsService.toggleFavorite(req.params.id, req.user!.sub);
  res.json(design);
});

export { designsRouter };
