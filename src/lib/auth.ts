import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { forbidden, unauthorized } from './errors';
import { ACCESS_COOKIE, verifyAccessToken } from './tokens';

export type AuthUser = { id: string; email: string; role: Role };

const ROLE_RANK: Record<Role, number> = {
  USER: 0,
  ANALYST: 1,
  SUPPORT: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function readAuth(request: FastifyRequest): AuthUser | null {
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookie = (request.cookies as Record<string, string | undefined> | undefined)?.[ACCESS_COOKIE];
  const token = bearer || cookie;
  if (!token) return null;
  const claims = verifyAccessToken(token);
  if (!claims) return null;
  return { id: claims.sub, email: claims.email, role: claims.role };
}

/** Attaches the user when a valid token is present; never rejects. */
export async function attachUser(request: FastifyRequest): Promise<void> {
  const user = readAuth(request);
  if (user) request.user = user;
}

export function requireAuth() {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw unauthorized();
  };
}

export function requireRole(minimum: Role) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw unauthorized();
    if (ROLE_RANK[request.user.role] < ROLE_RANK[minimum]) {
      throw forbidden(`Requires ${minimum} role or higher`);
    }
  };
}

export function hasRole(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * CSRF defence for cookie-authenticated writes. A custom header cannot be set
 * cross-origin without a CORS preflight we do not grant. Bearer-token requests
 * (API clients) are exempt because they cannot be forged by a browser form.
 */
export function checkCsrf(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (request.headers.authorization?.startsWith('Bearer ')) return;
  const hasCookie = Boolean((request.cookies as Record<string, string | undefined>)?.[ACCESS_COOKIE]);
  if (!hasCookie) return;
  if (request.headers['x-requested-with'] !== 'autopilot-forex') {
    throw forbidden('Missing CSRF header');
  }
}
