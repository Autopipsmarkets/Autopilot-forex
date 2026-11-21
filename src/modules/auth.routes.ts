import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../env';
import { prisma } from '../lib/prisma';
import { conflict, HttpError, unauthorized } from '../lib/errors';
import { burnPasswordTime, hashPassword, passwordSchema, verifyPassword } from '../lib/password';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieMaxAge,
  cookieOptions,
  emailTokenExpiry,
  randomToken,
  refreshExpiry,
  sha256,
  signAccessToken,
} from '../lib/tokens';
import { audit } from '../lib/audit';
import { resetEmail, sendMail, verificationEmail } from '../lib/mailer';
import { attachUser } from '../lib/auth';

const emailSchema = z.string().trim().toLowerCase().email().max(320);

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

function publicUser(user: {
  id: string;
  email: string;
  fullName: string;
  role: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt,
  };
}

function setSessionCookies(reply: FastifyReply, accessToken: string, refreshToken: string) {
  reply.setCookie(ACCESS_COOKIE, accessToken, cookieOptions(accessCookieMaxAge()));
  reply.setCookie(
    REFRESH_COOKIE,
    refreshToken,
    cookieOptions(env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60),
  );
}

async function issueSession(
  request: FastifyRequest,
  reply: FastifyReply,
  user: { id: string; email: string; role: Parameters<typeof signAccessToken>[0]['role'] },
) {
  const refreshToken = randomToken(48);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: refreshExpiry(),
      userAgent: request.headers['user-agent']?.slice(0, 300),
      ip: request.ip,
    },
  });

  setSessionCookies(reply, signAccessToken({ id: user.id, email: user.email, role: user.role }), refreshToken);
}

async function sendVerification(user: { id: string; email: string; fullName: string }) {
  const token = randomToken(32);
  await prisma.emailToken.create({
    data: {
      userId: user.id,
      type: 'VERIFY_EMAIL',
      tokenHash: sha256(token),
      expiresAt: emailTokenExpiry(60),
    },
  });

  const link = `${env.APP_URL}/api/auth/verify-email?token=${token}`;
  return sendMail({ to: user.email, ...verificationEmail(user.fullName, link) });
}

export async function authRoutes(app: FastifyInstance) {
  app.addHook('preHandler', attachUser);

  app.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const passwordHash = await hashPassword(body.password);

      let user;
      try {
        user = await prisma.user.create({
          data: {
            email: body.email,
            fullName: body.fullName,
            passwordHash,
            role: 'USER',
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw conflict('An account with this email already exists');
        }
        throw error;
      }

      await issueSession(request, reply, user);
      await sendVerification(user).catch((err) => request.log.error({ err }, 'verification email failed'));
      await audit({ request, action: 'auth.register', entity: 'User', entityId: user.id });

      return reply.code(201).send({ user: publicUser(user), requiresEmailVerification: true });
    },
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email } });

      if (!user) {
        await burnPasswordTime();
        throw unauthorized('Invalid email or password');
      }

      const ok = await verifyPassword(user.passwordHash, body.password);
      if (!ok) throw unauthorized('Invalid email or password');

      if (user.status === 'SUSPENDED') throw new HttpError(403, 'account_suspended', 'This account is suspended');
      if (user.status === 'DELETED') throw unauthorized('Invalid email or password');

      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await prisma.refreshToken.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date() } },
      });

      await issueSession(request, reply, user);
      await audit({ request, action: 'auth.login', entity: 'User', entityId: user.id });

      return { user: publicUser(user) };
    },
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    if (token) {
      await prisma.refreshToken
        .updateMany({
          where: { tokenHash: sha256(token), revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch(() => undefined);
    }
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const token = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
      if (!token) throw unauthorized('No session');

      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(token) },
        include: { user: true },
      });

      if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
        reply.clearCookie(ACCESS_COOKIE, { path: '/' });
        reply.clearCookie(REFRESH_COOKIE, { path: '/' });
        throw unauthorized('Session expired');
      }

      if (stored.user.status !== 'ACTIVE') throw unauthorized('Account is not active');

      // Rotate: the old token can never be used again.
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

      await issueSession(request, reply, stored.user);
      return { user: publicUser(stored.user) };
    },
  });

  /** Always 200: lets the site boot without a noisy 401 for guests. */
  app.get('/api/auth/session', async (request) => {
    if (!request.user) return { user: null };
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!user || user.status !== 'ACTIVE') return { user: null };
    return { user: publicUser(user) };
  });

  app.get('/api/auth/me', async (request) => {
    if (!request.user) throw unauthorized();
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!user || user.status !== 'ACTIVE') throw unauthorized();
    return { user: publicUser(user) };
  });

  app.post('/api/auth/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request) => {
      const body = z.object({ email: emailSchema }).parse(request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email } });

      if (user) {
        const token = randomToken(32);
        await prisma.emailToken.create({
          data: {
            userId: user.id,
            type: 'RESET_PASSWORD',
            tokenHash: sha256(token),
            expiresAt: emailTokenExpiry(30),
          },
        });
        const link = `${env.APP_URL}/reset.html?token=${token}`;
        await sendMail({ to: user.email, ...resetEmail(user.fullName, link) });
      }

      // Same response either way: do not leak which emails exist.
      return { ok: true, message: 'If that account exists, a reset link is on its way.' };
    },
  });

  app.post('/api/auth/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request) => {
      const body = z
        .object({ token: z.string().min(20), password: passwordSchema })
        .parse(request.body);

      const record = await prisma.emailToken.findUnique({
        where: { tokenHash: sha256(body.token) },
        include: { user: true },
      });

      if (
        !record ||
        record.type !== 'RESET_PASSWORD' ||
        record.usedAt ||
        record.expiresAt.getTime() < Date.now()
      ) {
        throw new HttpError(400, 'invalid_token', 'This reset link is invalid or has expired');
      }

      await prisma.$transaction([
        prisma.user.update({
          where: { id: record.userId },
          data: { passwordHash: await hashPassword(body.password) },
        }),
        prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
        prisma.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      await audit({ action: 'auth.password_reset', entity: 'User', entityId: record.userId });
      return { ok: true };
    },
  });

  app.get('/api/auth/verify-email', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20) }).parse(request.query);

    const record = await prisma.emailToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });

    if (
      !record ||
      record.type !== 'VERIFY_EMAIL' ||
      record.usedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      return reply.redirect(`${env.APP_URL}/?verified=invalid`, 302);
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
      prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);

    return reply.redirect(`${env.APP_URL}/?verified=1`, 302);
  });

  app.post('/api/auth/resend-verification', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    handler: async (request) => {
      if (!request.user) throw unauthorized();
      const user = await prisma.user.findUnique({ where: { id: request.user.id } });
      if (!user) throw unauthorized();
      if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };
      await sendVerification(user);
      return { ok: true };
    },
  });
}
