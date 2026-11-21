import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { attachUser, requireAuth } from '../lib/auth';
import { badRequest, notFound, notConfigured } from '../lib/errors';
import { env, payments } from '../env';
import { createCheckoutSession, stripe } from '../lib/stripe';
import { createMpesaCheckout } from '../lib/mpesa';
import { audit } from '../lib/audit';
import { getEntitlement, vipPayload } from '../lib/subscription';

export async function billingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', attachUser);

  app.get('/api/billing/plans', async () => {
    const plans = await prisma.plan.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
    });

    return {
      providers: { stripe: payments.stripeEnabled, mpesa: payments.mpesaEnabled },
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        priceCents: p.priceCents,
        currency: p.currency,
        interval: p.interval,
        features: p.features,
        available: {
          stripe: Boolean(p.stripePriceId) && payments.stripeEnabled,
          mpesa: p.currency === 'KES' && payments.mpesaEnabled,
        },
      })),
    };
  });

  app.post('/api/billing/checkout', { preHandler: [requireAuth()] }, async (request) => {
    const body = z
      .object({
        planCode: z.string().min(1).max(60),
        provider: z.enum(['stripe', 'mpesa']),
        phone: z.string().trim().min(9).max(20).optional(),
      })
      .parse(request.body);

    const plan = await prisma.plan.findUnique({ where: { code: body.planCode } });
    if (!plan || !plan.active) throw notFound('Plan not found');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });

    if (body.provider === 'stripe') {
      if (!payments.stripeEnabled) throw notConfigured('Card payments are not enabled yet');
      if (!plan.stripePriceId) throw notConfigured('This plan has no Stripe price configured');

      const url = await createCheckoutSession({
        userId: user.id,
        email: user.email,
        priceId: plan.stripePriceId,
        planCode: plan.code,
        successUrl: `${env.APP_URL}/?checkout=success`,
        cancelUrl: `${env.APP_URL}/?checkout=cancelled`,
      });

      await audit({ request, action: 'billing.checkout_started', entity: 'Plan', entityId: plan.id, meta: { provider: 'stripe' } });
      return { url };
    }

    if (!payments.mpesaEnabled) throw notConfigured('M-Pesa is not enabled yet');
    if (plan.currency !== 'KES') throw badRequest('M-Pesa requires a KES plan');
    if (!body.phone) throw badRequest('A phone number is required for M-Pesa');

    const checkout = await createMpesaCheckout({
      userId: user.id,
      email: user.email,
      planCode: plan.code,
      amount: plan.priceCents / 100,
      currency: plan.currency,
      phone: body.phone,
      redirectUrl: `${env.APP_URL}/?checkout=mpesa`,
    });

    await audit({ request, action: 'billing.checkout_started', entity: 'Plan', entityId: plan.id, meta: { provider: 'mpesa' } });
    return checkout;
  });

  app.post('/api/billing/cancel', { preHandler: [requireAuth()] }, async (request) => {
    const sub = await getEntitlement(request.user!.id);
    if (!sub) throw notFound('No active membership');

    if (sub.provider === 'stripe' && sub.providerRef && payments.stripeEnabled) {
      await stripe().subscriptions.update(sub.providerRef, { cancel_at_period_end: true });
    }

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true },
    });

    await audit({ request, action: 'billing.cancel_requested', entity: 'Subscription', entityId: sub.id });

    return {
      ok: true,
      membership: vipPayload({ ...sub, ...updated }),
      message:
        sub.provider === 'stripe'
          ? 'Your membership will end at the close of the current billing period.'
          : 'Cancellation recorded. The team will confirm before the next charge.',
    };
  });
}

/** Used by webhooks and admin grants. Adds one interval to a date. */
export function addInterval(from: Date, interval: 'MONTH' | 'YEAR'): Date {
  const next = new Date(from);
  if (interval === 'YEAR') next.setFullYear(next.getFullYear() + 1);
  else next.setMonth(next.getMonth() + 1);
  return next;
}
