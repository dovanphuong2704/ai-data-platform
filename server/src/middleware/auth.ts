import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  userId?: number;
  userEmail?: string;
}

/**
 * JWT verification middleware.
 *
 * Checks the Authorization header (Bearer token) first,
 * then falls back to the `token` cookie set during login.
 *
 * Attaches `userId` and `userEmail` to `req` on success.
 */
export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  // 1. Try Authorization header
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // 2. Fall back to cookie
  if (!token) {
    token = req.cookies?.token;
  }

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const secret = process.env.JWT_SECRET ?? 'changeme-in-production';

  try {
    const decoded = jwt.verify(token, secret) as {
      userId: number;
      email: string;
    };

    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

/**
 * Optional auth — attaches user info if a valid token is present,
 * but does NOT reject the request if one is missing.
 * Useful for routes that behave differently for logged-in users.
 */
export function optionalAuthMiddleware(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    token = req.cookies?.token;
  }

  if (!token) {
    next();
    return;
  }

  const secret = process.env.JWT_SECRET ?? 'changeme-in-production';

  try {
    const decoded = jwt.verify(token, secret) as {
      userId: number;
      email: string;
    };
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
  } catch {
    // Token invalid/expired — continue without user info
  }

  next();
}
