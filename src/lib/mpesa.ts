import crypto from 'node:crypto';
import { env, payments } from '../env';
import { HttpError, notConfigured } from './errors';

const BASE = 'https://api.intasend.com';
const SANDBOX_BASE = 'https://sandbox.intasend.com';

function base(): string {
  return env.INTASEND_SANDBOX ? SANDBOX_BASE : BASE;
}

/**
 * M-Pesa STK push through IntaSend. Kenya-first rail: the customer is asked for
 * the amount, gets a prompt on their phone, and pays in KES.
 */
export async function createMpesaCheckout(input: {
  userId: string;
  email: string;
  planCode: string;
  amount: number;
  currency: string;
  phone?: string;
  redirectUrl: string;
}): Promise<{ url: string; reference: string }> {
  if (!payments.mpesaEnabled) throw notConfigured('M-Pesa is not configured');

  const res = await fetch(`${base()}/api/v1/checkout/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.INTASEND_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      public_key: env.INTASEND_PUBLISHABLE_KEY,
      currency: input.currency,
      amount: input.amount,
      email: input.email,
      phone_number: input.phone,
      api_ref: `${input.planCode}:${input.userId}`,
      redirect_url: input.redirectUrl,
      comment: 'Autopilot VIP membership',
    }),
    signal: AbortSignal.timeout(15000),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok || !body.url) {
    throw new HttpError(502, 'payment_provider_error', 'Could not start M-Pesa checkout', body);
  }

  return { url: String(body.url), reference: String(body.id ?? body.invoice_id ?? '') };
}

/**
 * IntaSend signs webhooks with the challenge string configured in the
 * dashboard: HMAC-SHA256 over the raw body. We compare against their header.
 */
export function verifyIntasendSignature(rawBody: string, signature: string | undefined): boolean {
  const challenge = env.INTASEND_WEBHOOK_CHALLENGE;
  if (!challenge) return false;
  if (!signature) return false;

  const expected = crypto.createHmac('sha256', challenge).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
