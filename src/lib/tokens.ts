import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../env';

export const ACCESS_COOKIE = 'af_access';
export const REFRESH_COOKIE = 'af_refresh';

export type AccessClaims = {
  sub: string;
  email: string;
  role: Role;
  typ: 'access';
};

export function signAccessToken(input: { id: string; email: string; role: Role }): string {
  const payload: AccessClaims = {
    sub: input.id,
    email: input.email,
    role: input.role,
    typ: 'access',
  };
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'autopilot-forex',
    audience: 'autopilot-forex-web',
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: 'autopilot-forex',
      audience: 'autopilot-forex-web',
    }) as AccessClaims;
    if (!decoded || decoded.typ !== 'access') return null;
    return decoded;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function emailTokenExpiry(minutes = 60): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function accessCookieMaxAge(): number {
  // Keep the cookie slightly longer than the token; the server is the authority.
  return 60 * 60;
}
