import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import multer from 'multer';
import { BadRequestError } from './errorHandler.middleware';

// ── Zod request validation ────────────────────────────────────────────────────

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error:   'Validation failed',
        details: formatZodError(result.error),
        code:    'VALIDATION_ERROR',
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error:   'Invalid query parameters',
        details: formatZodError(result.error),
        code:    'VALIDATION_ERROR',
      });
      return;
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}

function formatZodError(err: ZodError) {
  return err.errors.map(e => ({ field: e.path.join('.'), message: e.message }));
}

// ── Multer file upload ────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE      = 10 * 1024 * 1024;  // 10 MB

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      // Use an AppError so the global handler returns 400 (a plain Error
      // would surface as a 500 in production).
      cb(new BadRequestError(`Invalid file type: ${file.mimetype}. Allowed: JPEG, PNG, WEBP`));
      return;
    }
    cb(null, true);
  },
});
