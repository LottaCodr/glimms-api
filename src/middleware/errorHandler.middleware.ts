import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../lib/logger';

// ── Custom error classes ──────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, `${resource} not found`, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, message, 'BAD_REQUEST');
  }
}

// ── Global error handler ──────────────────────────────────────────────────────

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Known app errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values((err as any).errors).map((e: any) => e.message);
    res.status(400).json({ error: 'Validation failed', details: messages, code: 'VALIDATION_ERROR' });
    return;
  }

  // Mongoose duplicate key
  if ((err as any).code === 11000) {
    const field = Object.keys((err as any).keyValue || {})[0] ?? 'field';
    res.status(409).json({ error: `${field} already exists`, code: 'DUPLICATE_KEY' });
    return;
  }

  // Mongoose cast error (e.g. invalid ObjectId)
  if (err.name === 'CastError') {
    res.status(400).json({ error: 'Invalid ID format', code: 'INVALID_ID' });
    return;
  }

  // Multer errors
  if (err.name === 'MulterError') {
    res.status(400).json({ error: err.message, code: 'FILE_ERROR' });
    return;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    return;
  }

  if (err.name === 'TokenExpiredError') {
    res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return;
  }

  // Unknown — log and hide details in production
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  res.status(500).json({
    error: config.isDev ? err.message : 'Something went wrong',
    code:  'INTERNAL_ERROR',
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}
