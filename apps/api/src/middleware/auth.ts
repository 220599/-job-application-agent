import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../logger';

// Development user ID - will be replaced with real auth later
export const DEV_USER_ID = process.env.DEV_USER_ID || 'dev-user-123';

// Extend Express Request to include userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      requestId?: string;
    }
  }
}

// Middleware to add user context (development only)
export const userMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // In development, use DEV_USER_ID
  // In production, this will be replaced with real authentication
  req.userId = process.env.USER_ID || DEV_USER_ID;
  req.requestId = req.headers['x-request-id'] as string || Math.random().toString(36);
  next();
};

// Error handling middleware
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error('[ERROR HANDLER]', err.message, err.stack);
  logger.error('API Error', err, {
    requestId: req.requestId,
    userId: req.userId,
    path: req.path,
    method: req.method,
    stack: err.stack,
  });

  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
  }

  // Generic error
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
};

// Async route handler wrapper to catch errors
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    console.log(`[ASYNC HANDLER] ${req.method} ${req.path}`);
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error('[ASYNC HANDLER ERROR]', err.message, err.stack);
      next(err);
    });
  };
