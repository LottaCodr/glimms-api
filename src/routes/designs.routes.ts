// ── designs.routes.ts ─────────────────────────────────────────────────────────

import { Router } from 'express';
import { z } from 'zod';
import { designsService } from '../services/designs.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody, validateQuery } from '../middleware/validate.middleware';

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

const paginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/designs/jobs — paginated
designsRouter.get('/jobs', requireAuth, validateQuery(paginationSchema), async (req: AuthRequest, res) => {
  const { page, limit } = (req as any).validatedQuery;
  const result = await designsService.listJobs(req.user!.sub, { page, limit });
  res.json(result);
});

// GET /api/designs/jobs/:id
designsRouter.get('/jobs/:id', requireAuth, async (req: AuthRequest, res) => {
  const job = await designsService.getJob(req.params.id, req.user!.sub);
  res.json(job);
});

// GET /api/designs/saved — paginated + favorite filter
designsRouter.get('/saved', requireAuth, validateQuery(z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  favorite: z.coerce.boolean().optional(),
})), async (req: AuthRequest, res) => {
  const { page, limit, favorite } = (req as any).validatedQuery;
  const result = await designsService.getSavedDesigns(req.user!.sub, { page, limit, favorite });
  res.json(result);
});

// DELETE /api/designs/saved/:id
designsRouter.delete('/saved/:id', requireAuth, async (req: AuthRequest, res) => {
  const result = await designsService.deleteSavedDesign(req.params.id, req.user!.sub);
  res.json(result);
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
