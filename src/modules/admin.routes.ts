import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { attachUser, requireRole } from '../lib/auth';
import { badRequest, notFound, paginate } from '../lib/errors';
import { audit } from '../lib/audit';
import { hashPassword, passwordSchema } from '../lib/password';
import { addInterval } from './billing.routes';

const idParam = z.object({ id: z.string().uuid() });

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

const signalInput = z.object({
  pair: z.string().trim().min(3).max(20),
  direction: z.enum(['BUY', 'SELL']),
  timeframe: z.string().trim().min(1).max(10).default('H1'),
  entry: z.coerce.number().positive(),
  stopLoss: z.coerce.number().positive().optional().nullable(),
  takeProfit: z.coerce.number().positive().optional().nullable(),
  confidence: z.coerce.number().int().min(0).max(100).default(50),
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).default('OPEN'),
  vipOnly: z.boolean().default(true),
  notes: z.string().max(4000).optional().nullable(),
  resultPct: z.coerce.number().optional().nullable(),
});

const postInput = z.object({
  title: z.string().trim().min(3).max(200),
  slug: z.string().trim().max(100).optional(),
  category: z.enum(['ANALYSIS', 'EDUCATION', 'ANNOUNCEMENT']).default('ANALYSIS'),
  excerpt: z.string().trim().max(400).optional().nullable(),
  body: z.string().min(1).max(100000),
  coverUrl: z.string().url().optional().nullable(),
  vipOnly: z.boolean().default(false),
  published: z.boolean().default(false),
});

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', attachUser);

  // ── Overview ────────────────────────────────────────────────────────────
  app.get('/api/admin/stats', { preHandler: [requireRole('SUPPORT')] }, async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [users, newUsers, activeSubs, revenue, openSignals, newMessages, recentUsers, recentPayments] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { createdAt: { gte: since } } }),
        prisma.subscription.count({
          where: { status: 'ACTIVE', OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }] },
        }),
        prisma.payment.aggregate({ where: { status: 'PAID' }, _sum: { amountCents: true } }),
        prisma.signal.count({ where: { status: 'OPEN' } }),
        prisma.contactMessage.count({ where: { status: 'NEW' } }),
        prisma.user.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, email: true, fullName: true, role: true, status: true, createdAt: true },
        }),
        prisma.payment.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: { user: { select: { email: true } }, plan: { select: { name: true } } },
        }),
      ]);

    return {
      users,
      newUsers7d: newUsers,
      activeSubscriptions: activeSubs,
      revenueCents: revenue._sum.amountCents ?? 0,
      openSignals,
      newMessages,
      recentUsers,
      recentPayments,
    };
  });

  // ── Users ───────────────────────────────────────────────────────────────
  app.get('/api/admin/users', { preHandler: [requireRole('SUPPORT')] }, async (request) => {
    const query = z
      .object({
        q: z.string().trim().max(120).optional(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
        page: z.string().optional(),
        pageSize: z.string().optional(),
      })
      .parse(request.query);

    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' as const } },
              { fullName: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          lastLoginAt: true,
          createdAt: true,
          subscriptions: {
            where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
            include: { plan: { select: { code: true, name: true } } },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.get('/api/admin/users/:id', { preHandler: [requireRole('SUPPORT')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' } },
        payments: { orderBy: { createdAt: 'desc' }, take: 25 },
      },
    });
    if (!user) throw notFound('User not found');

    const { passwordHash: _ph, ...safe } = user;
    return { user: safe };
  });

  app.patch('/api/admin/users/:id', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        fullName: z.string().trim().min(2).max(120).optional(),
        role: z.enum(['USER', 'ANALYST', 'SUPPORT', 'ADMIN', 'OWNER']).optional(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
        password: passwordSchema.optional(),
      })
      .parse(request.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('User not found');

    if (body.role && request.user!.role !== 'OWNER' && (body.role === 'OWNER' || target.role === 'OWNER')) {
      throw badRequest('Only an owner can change owner-level roles');
    }
    if (target.id === request.user!.id && body.status && body.status !== 'ACTIVE') {
      throw badRequest('You cannot suspend your own account');
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        fullName: body.fullName,
        role: body.role,
        status: body.status,
        ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
      },
    });

    if (body.status && body.status !== 'ACTIVE') {
      await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await audit({
      request,
      action: 'admin.user_update',
      entity: 'User',
      entityId: id,
      meta: { fields: Object.keys(body).filter((k) => k !== 'password') },
    });

    const { passwordHash: _ph, ...safe } = updated;
    return { user: safe };
  });

  app.post('/api/admin/users/:id/grant', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        planCode: z.string().min(1),
        months: z.coerce.number().int().min(1).max(36).default(1),
        reason: z.string().max(300).optional(),
      })
      .parse(request.body);

    const [user, plan] = await Promise.all([
      prisma.user.findUnique({ where: { id } }),
      prisma.plan.findUnique({ where: { code: body.planCode } }),
    ]);
    if (!user) throw notFound('User not found');
    if (!plan) throw notFound('Plan not found');

    const start = new Date();
    let end = start;
    for (let i = 0; i < body.months; i += 1) end = addInterval(end, plan.interval);

    const sub = await prisma.subscription.create({
      data: {
        userId: id,
        planId: plan.id,
        status: 'ACTIVE',
        provider: 'manual',
        providerRef: `manual:${request.user!.id}:${Date.now()}`,
        currentPeriodEnd: end,
      },
    });

    await audit({
      request,
      action: 'admin.subscription_grant',
      entity: 'Subscription',
      entityId: sub.id,
      meta: { planCode: plan.code, months: body.months, reason: body.reason ?? null },
    });

    return { subscription: sub };
  });

  // ── Signals ─────────────────────────────────────────────────────────────
  app.get('/api/admin/signals', { preHandler: [requireRole('ANALYST')] }, async (request) => {
    const query = z
      .object({ page: z.string().optional(), pageSize: z.string().optional() })
      .parse(request.query);
    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const [items, total] = await Promise.all([
      prisma.signal.findMany({ orderBy: { publishedAt: 'desc' }, skip, take }),
      prisma.signal.count(),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.post('/api/admin/signals', { preHandler: [requireRole('ANALYST')] }, async (request, reply) => {
    const body = signalInput.parse(request.body);
    const signal = await prisma.signal.create({
      data: {
        ...body,
        createdById: request.user!.id,
        publishedAt: new Date(),
        closedAt: body.status === 'CLOSED' ? new Date() : null,
      },
    });
    await audit({ request, action: 'admin.signal_create', entity: 'Signal', entityId: signal.id });
    return reply.code(201).send({ signal });
  });

  app.patch('/api/admin/signals/:id', { preHandler: [requireRole('ANALYST')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = signalInput.partial().parse(request.body);

    const existing = await prisma.signal.findUnique({ where: { id } });
    if (!existing) throw notFound('Signal not found');

    const signal = await prisma.signal.update({
      where: { id },
      data: {
        ...body,
        ...(body.status === 'CLOSED' && !existing.closedAt ? { closedAt: new Date() } : {}),
        ...(body.status && body.status !== 'CLOSED' ? { closedAt: null } : {}),
      },
    });

    await audit({ request, action: 'admin.signal_update', entity: 'Signal', entityId: id });
    return { signal };
  });

  app.delete('/api/admin/signals/:id', { preHandler: [requireRole('ANALYST')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await prisma.signal.delete({ where: { id } }).catch(() => {
      throw notFound('Signal not found');
    });
    await audit({ request, action: 'admin.signal_delete', entity: 'Signal', entityId: id });
    return { ok: true };
  });

  // ── Posts ───────────────────────────────────────────────────────────────
  app.get('/api/admin/posts', { preHandler: [requireRole('ANALYST')] }, async (request) => {
    const query = z
      .object({ page: z.string().optional(), pageSize: z.string().optional() })
      .parse(request.query);
    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const [items, total] = await Promise.all([
      prisma.post.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.post.count(),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.post('/api/admin/posts', { preHandler: [requireRole('ANALYST')] }, async (request, reply) => {
    const body = postInput.parse(request.body);

    let slug = body.slug ? slugify(body.slug) : slugify(body.title);
    if (!slug) slug = `post-${Date.now()}`;
    const clash = await prisma.post.findUnique({ where: { slug } });
    if (clash) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

    const post = await prisma.post.create({
      data: {
        slug,
        title: body.title,
        category: body.category,
        excerpt: body.excerpt,
        body: body.body,
        coverUrl: body.coverUrl,
        vipOnly: body.vipOnly,
        published: body.published,
        publishedAt: body.published ? new Date() : null,
        authorId: request.user!.id,
      },
    });

    await audit({ request, action: 'admin.post_create', entity: 'Post', entityId: post.id });
    return reply.code(201).send({ post });
  });

  app.patch('/api/admin/posts/:id', { preHandler: [requireRole('ANALYST')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = postInput.partial().parse(request.body);

    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) throw notFound('Post not found');

    const post = await prisma.post.update({
      where: { id },
      data: {
        ...body,
        ...(body.slug ? { slug: slugify(body.slug) } : {}),
        ...(body.published === true && !existing.publishedAt ? { publishedAt: new Date() } : {}),
      },
    });

    await audit({ request, action: 'admin.post_update', entity: 'Post', entityId: id });
    return { post };
  });

  app.delete('/api/admin/posts/:id', { preHandler: [requireRole('ANALYST')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await prisma.post.delete({ where: { id } }).catch(() => {
      throw notFound('Post not found');
    });
    await audit({ request, action: 'admin.post_delete', entity: 'Post', entityId: id });
    return { ok: true };
  });

  // ── Plans ───────────────────────────────────────────────────────────────
  app.get('/api/admin/plans', { preHandler: [requireRole('SUPPORT')] }, async () => {
    const plans = await prisma.plan.findMany({ orderBy: { priceCents: 'asc' } });
    return { items: plans };
  });

  app.put('/api/admin/plans/:code', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const { code } = z.object({ code: z.string().min(1).max(60) }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        description: z.string().max(400).optional().nullable(),
        priceCents: z.coerce.number().int().min(0).max(10_000_000),
        currency: z.string().trim().length(3).default('USD'),
        interval: z.enum(['MONTH', 'YEAR']).default('MONTH'),
        stripePriceId: z.string().max(200).optional().nullable(),
        features: z.array(z.string().max(120)).max(20).default([]),
        active: z.boolean().default(true),
        sortOrder: z.coerce.number().int().default(0),
      })
      .parse(request.body);

    const plan = await prisma.plan.upsert({
      where: { code },
      update: { ...body, currency: body.currency.toUpperCase() },
      create: { code, ...body, currency: body.currency.toUpperCase() },
    });

    await audit({ request, action: 'admin.plan_upsert', entity: 'Plan', entityId: plan.id });
    return { plan };
  });

  // ── Subscriptions & payments ────────────────────────────────────────────
  app.get('/api/admin/subscriptions', { preHandler: [requireRole('SUPPORT')] }, async (request) => {
    const query = z
      .object({ page: z.string().optional(), pageSize: z.string().optional() })
      .parse(request.query);
    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const [items, total] = await Promise.all([
      prisma.subscription.findMany({
        include: { user: { select: { email: true, fullName: true } }, plan: { select: { name: true, code: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.subscription.count(),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.get('/api/admin/payments', { preHandler: [requireRole('SUPPORT')] }, async (request) => {
    const query = z
      .object({ page: z.string().optional(), pageSize: z.string().optional() })
      .parse(request.query);
    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        include: { user: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.payment.count(),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  // ── Messages ────────────────────────────────────────────────────────────
  app.get('/api/admin/messages', { preHandler: [requireRole('SUPPORT')] }, async (request) => {
    const query = z
      .object({ status: z.enum(['NEW', 'READ', 'ARCHIVED']).optional(), page: z.string().optional(), pageSize: z.string().optional() })
      .parse(request.query);
    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const where = query.status ? { status: query.status } : {};
    const [items, total] = await Promise.all([
      prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.contactMessage.count({ where }),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.patch('/api/admin/messages/:id', { preHandler: [requireRole('SUPPORT')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ status: z.enum(['NEW', 'READ', 'ARCHIVED']) }).parse(request.body);
    const message = await prisma.contactMessage.update({ where: { id }, data: body });
    await audit({ request, action: 'admin.message_update', entity: 'ContactMessage', entityId: id });
    return { message };
  });

  // ── Audit & settings ────────────────────────────────────────────────────
  app.get('/api/admin/audit', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const query = z
      .object({ page: z.string().optional(), pageSize: z.string().optional() })
      .parse(request.query);
    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        include: { actor: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.auditLog.count(),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.get('/api/admin/settings', { preHandler: [requireRole('ADMIN')] }, async () => {
    const settings = await prisma.setting.findMany();
    return {
      items: Object.fromEntries(settings.map((s) => [s.key, s.value])),
    };
  });

  app.put('/api/admin/settings/:key', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(request.params);
    const body = z.object({ value: z.unknown() }).parse(request.body);

    const setting = await prisma.setting.upsert({
      where: { key },
      update: { value: body.value as never },
      create: { key, value: body.value as never },
    });

    await audit({ request, action: 'admin.setting_update', entity: 'Setting', entityId: key });
    return { setting };
  });
}
