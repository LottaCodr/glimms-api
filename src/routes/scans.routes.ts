import { Router } from 'express';
import { z } from 'zod';
import { scansService } from '../services/scans.service';
import { designsService } from '../services/designs.service';
import { contextService } from '../services/context.service';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { scanLimiter } from '../middleware/rateLimiter.middleware';
import { uploadMiddleware } from '../middleware/validate.middleware';

const router = Router();

// POST /api/scans/upload
// Body: multipart/form-data
//   - images[]        — image files (1–5)
//   - vertical        — wardrobe | room | garden
//   - occasion        — (optional)
//   - occupation      — (optional)
//   - culturalCtx     — (optional)
//   - lat / lon       — (optional, for climate context)
router.post(
  '/upload',
  requireAuth,
  scanLimiter,
  uploadMiddleware.array('images', 5),
  async (req: AuthRequest, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files?.length) {
      res.status(400).json({ error: 'At least one image is required', code: 'NO_FILES' });
      return;
    }

    // Parse and coerce form fields
    const schema = z.object({
      vertical:   z.enum(['wardrobe', 'room', 'garden']),
      occasion:   z.string().optional(),
      occupation: z.string().optional(),
      culturalCtx: z.string().optional(),
      lat:        z.coerce.number().optional(),
      lon:        z.coerce.number().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid scan parameters', details: parsed.error.flatten() });
      return;
    }

    const { vertical, occasion, occupation, culturalCtx, lat, lon } = parsed.data;

    // Build enriched context (weather + culture + occasion)
    let contextData: Record<string, unknown> = { occasion, occupation, culturalCtx };
    if (lat !== undefined && lon !== undefined) {
      contextData = await contextService.buildContext(lat, lon, { occasion, occupation, culturalCtx });
    }

    // Upload to S3 (normalised, EXIF-stripped)
    const { uploadedKeys, qualityWarning } = await scansService.processUpload(
      files,
      req.user!.sub,
      vertical,
      contextData,
    );

    // Create design job and enqueue AI pipeline
    const job = await designsService.createJob(req.user!.sub, req.user!.tier, {
      vertical,
      imageKeys: uploadedKeys,
      contextData,
    });

    res.status(202).json({
      ...job,
      ...(qualityWarning && { qualityWarning }),
    });
  },
);

export default router;
