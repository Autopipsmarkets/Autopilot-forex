import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { constructStripeEvent, stripe } from '../lib/stripe';
import { verifyIntasendSignature } from '../lib/mpesa';
import { badRequest, notConfigured } from '../lib/errors';
import { env, payments } from '../env';
import { addInterval } from './billing.routes';

async function upsertSubscriptionFromStripe(subscription: Stripe.Subscription) {
  const userId = (subscription.metadata.userId as string | undefined) ?? null;
  const planCode = (subscription.metadata.planCode as string | undefined) ?? 'vip-monthly';

  const existing = await prisma.subscription.findFirst({ where: { providerRef: subscription.id } });

  let resolvedUserId = userId ?? existing?.userId ?? null;
  if (!resolvedUserId && subscription.customer) {
    const customerId = String(subscription.customer);
    const byCustomer = await prisma.user.findFirst({
      where: { payments: { some: { providerRef: customerId } } },
      select: { id: true },
    });
    resolvedUserId = byCustomer?.id ?? null;
  }
  if (!resolvedUserId) return;

  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) return;

  const statusMap: Record<string, 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' | 'PENDING'> = {
    active: 'ACTIVE',
    trialing: 'ACTIVE',
    past_due: 'PAST_DUE',
    canceled: 'CANCELLED',
    unpaid: 'EXPIRED',
    incomplete: 'PENDING',
    incomplete_expired: 'EXPIRED',
    paused: 'CANCELLED',
  };

  const data = {
    userId: resolvedUserId,
    planId: plan.id,
    status: statusMap[subscription.status] ?? 'PENDING',
    provider: 'stripe',
    providerRef: subscription.id,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };

  if (existing) {
    await prisma.subscription.update({ where: { id: existing.id }, data });
  } else {
    await prisma.subscription.create({ data });
  }
}

async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id ?? (session.metadata?.userId as string | undefined);
      const planCode = session.metadata?.planCode as string | undefined;
      if (!userId || !session.subscription) return;

      const subscription = await stripe().subscriptions.retrieve(String(session.subscription));
      if (!subscription.metadata.userId) {
        subscription.metadata = { ...subscription.metadata, userId };
      }
      if (planCode && !subscription.metadata.planCode) {
        subscription.metadata = { ...subscription.metadata, planCode };
      }
      await upsertSubscriptionFromStripe(subscription);

      await prisma.payment.upsert({
        where: { providerRef: session.id },
        update: { status: 'PAID' },
        create: {
          userId,
          provider: 'stripe',
          providerRef: session.id,
          amountCents: session.amount_total ?? 0,
          currency: (session.currency ?? 'usd').toUpperCase(),
          status: 'PAID',
          raw: session as unknown as never,
        },
      });
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await upsertSubscriptionFromStripe(event.data.object as Stripe.Subscription);
      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = invoice.subscription ? String(invoice.subscription) : null;
      if (subId) {
        await prisma.subscription.updateMany({
          where: { providerRef: subId },
          data: { status: 'PAST_DUE' },
        });
      }
      return;
    }

    default:
      return;
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  // Scoped parser: only webhook routes keep the raw body (needed for signatures).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request: FastifyRequest, body: Buffer, done) => {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.post('/api/webhooks/stripe', async (request, reply) => {
    if (!payments.stripeEnabled) throw notConfigured('Stripe is not configured');
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') throw badRequest('Missing stripe-signature header');

    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!raw) throw badRequest('Missing raw body');

    let event: Stripe.Event;
    try {
      event = constructStripeEvent(raw, signature);
    } catch (error) {
      request.log.warn({ err: error }, 'stripe signature verification failed');
      throw badRequest('Invalid Stripe signature');
    }

    // Idempotency: the event id is recorded via payment upserts and status writes.
    await handleStripeEvent(event);
    return reply.code(200).send({ received: true });
  });

  app.post('/api/webhooks/intasend', async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
    const signature = request.headers['x-intasend-signature'];
    const body = request.body as Record<string, unknown>;

    const challengeOk =
      Boolean(env.INTASEND_WEBHOOK_CHALLENGE) && body.challenge === env.INTASEND_WEBHOOK_CHALLENGE;
    const signatureOk = verifyIntasendSignature(raw, typeof signature === 'string' ? signature : undefined);

    if (!challengeOk && !signatureOk) {
      request.log.warn('intasend webhook rejected: bad signature');
      throw badRequest('Invalid webhook signature');
    }

    const state = String(body.state ?? '').toUpperCase();
    const apiRef = String(body.api_ref ?? '');
    const [planCode, userId] = apiRef.split(':');
    const invoiceId = String(body.invoice_id ?? body.id ?? '');

    if (state !== 'COMPLETE' || !planCode || !userId || !invoiceId) {
      return reply.code(200).send({ received: true, ignored: true });
    }

    const plan = await prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) return reply.code(200).send({ received: true, ignored: 'unknown plan' });

    const already = await prisma.payment.findUnique({ where: { providerRef: invoiceId } });
    if (already) return reply.code(200).send({ received: true, duplicate: true });

    const periodEnd = addInterval(new Date(), plan.interval);

    const subscription = await prisma.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'ACTIVE',
        provider: 'intasend',
        providerRef: invoiceId,
        currentPeriodEnd: periodEnd,
      },
    });

    await prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        subscriptionId: subscription.id,
        provider: 'intasend',
        providerRef: invoiceId,
        amountCents: Math.round(Number(body.value ?? body.amount ?? plan.priceCents / 100) * 100),
        currency: String(body.currency ?? plan.currency),
        status: 'PAID',
        raw: body as never,
      },
    });

    return reply.code(200).send({ received: true });
  });
}
