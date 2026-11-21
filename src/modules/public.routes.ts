import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { paginate } from '../lib/errors';
import { attachUser } from '../lib/auth';
import { canViewSignal, getEntitlement } from '../lib/subscription';
import { getQuotes, marketDataStatus } from '../lib/market';
import { payments } from '../env';
import { audit } from '../lib/audit';

export async function publicRoutes(app: FastifyInstance) {
  app.addHook('preHandler', attachUser);

  app.get('/api/public/site', async () => {
    const plans = await prisma.plan.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
    });

    return {
      brand: {
        name: 'Autopilot Forex',
        company: 'Autopips Markets',
        tagline: 'Trade smarter. Not harder.',
      },
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        description: p.description,
        priceCents: p.priceCents,
        currency: p.currency,
        interval: p.interval,
        features: p.features,
      })),
      capabilities: {
        cardPayments: payments.stripeEnabled,
        mpesa: payments.mpesaEnabled,
        marketData: payments.marketDataEnabled,
      },
      riskNotice:
        'Forex and CFD trading involve substantial risk. You can lose your invested capital. Nothing here is financial advice.',
    };
  });

  app.get('/api/public/markets', async (_request, reply) => {
    if (!payments.marketDataEnabled) {
      return reply.code(200).send({
        quotes: [],
        errors: [],
        status: { ...marketDataStatus(), message: 'Live market data is not configured yet.' },
      });
    }
    const result = await getQuotes();
    return { ...result, status: marketDataStatus() };
  });

  app.get('/api/public/posts', async (request) => {
    const query = z
      .object({
        category: z.enum(['ANALYSIS', 'EDUCATION', 'ANNOUNCEMENT']).optional(),
        page: z.string().optional(),
        pageSize: z.string().optional(),
      })
      .parse(request.query);

    const { skip, take, page, pageSize } = paginate(query.page, query.pageSize);

    const where = { published: true, ...(query.category ? { category: query.category } : {}) };
    const [items, total] = await Promise.all([
      prisma.post.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take,
        select: {
          slug: true,
          title: true,
          category: true,
          excerpt: true,
          coverUrl: true,
          vipOnly: true,
          publishedAt: true,
        },
      }),
      prisma.post.count({ where }),
    ]);

    return { items, total, page, pageSize, hasMore: skip + items.length < total };
  });

  app.get('/api/public/posts/:slug', async (request) => {
    const { slug } = z.object({ slug: z.string().min(1).max(200) }).parse(request.params);
    const post = await prisma.post.findFirst({ where: { slug, published: true } });
    if (!post) throw Object.assign(new Error('Not found'), { statusCode: 404, code: 'not_found' });

    const viewer = request.user
      ? await getEntitlement(request.user.id).then((sub) => ({
          vip: Boolean(sub),
          role: request.user?.role,
        }))
      : null;

    if (post.vipOnly && !canViewSignal({ vipOnly: true }, viewer)) {
      return {
        slug: post.slug,
        title: post.title,
        category: post.category,
        excerpt: post.excerpt,
        coverUrl: post.coverUrl,
        vipOnly: true,
        locked: true,
        body: null,
        publishedAt: post.publishedAt,
      };
    }

    return { ...post, locked: false };
  });

  app.get('/api/public/signals', async (request) => {
    const entitlement = request.user ? await getEntitlement(request.user.id) : null;
    const viewer = request.user ? { vip: Boolean(entitlement), role: request.user.role } : null;

    const signals = await prisma.signal.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        pair: true,
        direction: true,
        timeframe: true,
        entry: true,
        stopLoss: true,
        takeProfit: true,
        confidence: true,
        status: true,
        vipOnly: true,
        notes: true,
        resultPct: true,
        publishedAt: true,
        closedAt: true,
      },
    });

    return {
      items: signals.map((signal) => {
        if (canViewSignal(signal, viewer)) return { ...signal, locked: false };
        return {
          id: signal.id,
          pair: signal.pair,
          direction: signal.direction,
          timeframe: signal.timeframe,
          status: signal.status,
          vipOnly: true,
          publishedAt: signal.publishedAt,
          locked: true,
        };
      }),
      vip: Boolean(entitlement),
    };
  });

  app.post('/api/contact', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    handler: async (request) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(120),
          email: z.string().trim().toLowerCase().email().max(320),
          subject: z.string().trim().min(3).max(160),
          message: z.string().trim().min(10).max(4000),
        })
        .parse(request.body);

      const created = await prisma.contactMessage.create({
        data: { ...body, ip: request.ip },
      });

      await audit({ request, action: 'contact.create', entity: 'ContactMessage', entityId: created.id });
      return { ok: true, id: created.id };
    },
  });
}
