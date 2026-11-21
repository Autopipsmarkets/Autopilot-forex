import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { unauthorized, badRequest } from '../lib/errors';
import { attachUser, requireAuth } from '../lib/auth';
import { getEntitlement, vipPayload, canViewSignal } from '../lib/subscription';
import { hashPassword, passwordSchema, verifyPassword } from '../lib/password';
import { audit } from '../lib/audit';

export async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', attachUser);

  app.get('/api/me', { preHandler: [requireAuth()] }, async (request) => {
    const [user, sub] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } }),
      getEntitlement(request.user!.id),
    ]);

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        emailVerified: Boolean(user.emailVerifiedAt),
        createdAt: user.createdAt,
      },
      membership: vipPayload(sub),
    };
  });

  app.patch('/api/me', { preHandler: [requireAuth()] }, async (request) => {
    const body = z
      .object({ fullName: z.string().trim().min(2).max(120).optional() })
      .parse(request.body);

    const user = await prisma.user.update({
      where: { id: request.user!.id },
      data: { fullName: body.fullName },
    });

    await audit({ request, action: 'me.update', entity: 'User', entityId: user.id });
    return { user: { id: user.id, email: user.email, fullName: user.fullName } };
  });

  app.post('/api/me/change-password', { preHandler: [requireAuth()] }, async (request) => {
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
      .parse(request.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw badRequest('Current password is incorrect');
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(body.newPassword) },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await audit({ request, action: 'me.change_password', entity: 'User', entityId: user.id });
    return { ok: true, message: 'Password changed. Sign in again on other devices.' };
  });

  app.get('/api/me/subscription', { preHandler: [requireAuth()] }, async (request) => {
    const sub = await getEntitlement(request.user!.id);
    const history = await prisma.subscription.findMany({
      where: { userId: request.user!.id },
      include: { plan: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      membership: vipPayload(sub),
      history: history.map((s) => ({
        id: s.id,
        plan: s.plan.name,
        planCode: s.plan.code,
        status: s.status,
        provider: s.provider,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        createdAt: s.createdAt,
      })),
    };
  });

  app.get('/api/me/signals', { preHandler: [requireAuth()] }, async (request) => {
    const sub = await getEntitlement(request.user!.id);
    const signals = await prisma.signal.findMany({ orderBy: { publishedAt: 'desc' }, take: 50 });

    return {
      vip: Boolean(sub),
      items: signals.map((signal) => {
        const allowed = canViewSignal(signal, { vip: Boolean(sub), role: request.user!.role });
        return allowed ? { ...signal, locked: false } : {
          id: signal.id,
          pair: signal.pair,
          direction: signal.direction,
          timeframe: signal.timeframe,
          status: signal.status,
          publishedAt: signal.publishedAt,
          vipOnly: true,
          locked: true,
        };
      }),
    };
  });

  app.get('/api/me/purchases', { preHandler: [requireAuth()] }, async (request) => {
    if (!request.user) throw unauthorized();
    const payments = await prisma.payment.findMany({
      where: { userId: request.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: payments };
  });
}
