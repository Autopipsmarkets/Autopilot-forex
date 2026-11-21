import Stripe from 'stripe';
import { env, payments } from '../env';
import { notConfigured } from './errors';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!payments.stripeEnabled) throw notConfigured('Stripe is not configured');
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
      appInfo: { name: 'autopilot-forex' },
    });
  }
  return client;
}

export async function createCheckoutSession(input: {
  userId: string;
  email: string;
  priceId: string;
  planCode: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer_email: input.email,
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.userId,
    metadata: { userId: input.userId, planCode: input.planCode },
    subscription_data: { metadata: { userId: input.userId, planCode: input.planCode } },
    allow_promotion_codes: true,
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

export function constructStripeEvent(payload: Buffer, signature: string): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) throw notConfigured('STRIPE_WEBHOOK_SECRET is missing');
  return stripe().webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
}
