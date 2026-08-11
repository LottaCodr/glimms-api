import { Router } from 'express';
import { z } from 'zod';
import { catalogService } from '../services/catalog.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { validateBody, validateQuery } from '../middleware/validate.middleware';

const router = Router();

const createItemSchema = z.object({
  vertical:   z.enum(['wardrobe', 'room', 'garden']),
  label:      z.string().min(1),
  category:   z.string().min(1),
  color:      z.object({
    dominant: z.object({ hex: z.string(), rgb: z.object({ r: z.number(), g: z.number(), b: z.number() }) }),
    palette:  z.array(z.any()).optional(),
    mood:     z.string().optional(),
  }).passthrough(),
  imageKey:    z.string().min(1),
  confidence:  z.number().min(0).max(1),
  texture:     z.string().optional(),
  pattern:     z.string().optional(),
  tags:        z.array(z.string()).optional(),
  styleTags:   z.array(z.string()).optional(),
  attributes:  z.record(z.unknown()).optional(),
});

const updateItemSchema = z.object({
  label:      z.string().optional(),
  tags:       z.array(z.string()).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  vertical: z.enum(['wardrobe', 'room', 'garden']).optional(),
  category: z.string().optional(),
  tag:      z.string().optional(),
});

// GET /api/catalog
router.get('/', requireAuth, validateQuery(listQuerySchema), async (req: AuthRequest, res) => {
  const items = await catalogService.list(req.user!.sub, (req as any).validatedQuery);
  res.json(items);
});

// GET /api/catalog/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const item = await catalogService.findOne(req.params.id, req.user!.sub);
  res.json(item);
});

// POST /api/catalog
router.post('/', requireAuth, validateBody(createItemSchema), async (req: AuthRequest, res) => {
  const item = await catalogService.create(req.user!.sub, req.body);
  res.status(201).json(item);
});

// PATCH /api/catalog/:id
router.patch('/:id', requireAuth, validateBody(updateItemSchema), async (req: AuthRequest, res) => {
  const item = await catalogService.update(req.params.id, req.user!.sub, req.body);
  res.json(item);
});

// DELETE /api/catalog/:id
router.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  const result = await catalogService.remove(req.params.id, req.user!.sub);
  res.json(result);
});

export default router;
