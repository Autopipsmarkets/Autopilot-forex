import type { Plan, Subscription } from '@prisma/client';
import { prisma } from './prisma';

export type SubscriptionWithPlan = Subscription & { plan: Plan };

export const ENTITLED_STATUSES = new Set(['ACTIVE', 'PAST_DUE']);

export function isSubscriptionActive(
  sub: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null | undefined,
  now = new Date(),
): boolean {
  if (!sub) return false;
  if (!ENTITLED_STATUSES.has(sub.status)) return false;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() < now.getTime()) return false;
  return true;
}

/** The most recent subscription that currently grants VIP access. */
export async function getEntitlement(userId: string): Promise<SubscriptionWithPlan | null> {
  const subs = await prisma.subscription.findMany({
    where: { userId },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  return subs.find((s) => isSubscriptionActive(s) && s.plan.active) ?? null;
}

export function vipPayload(sub: SubscriptionWithPlan | null) {
  if (!sub) return { vip: false as const };
  return {
    vip: true as const,
    plan: {
      code: sub.plan.code,
      name: sub.plan.name,
      interval: sub.plan.interval,
      priceCents: sub.plan.priceCents,
      currency: sub.plan.currency,
    },
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

/** Decides whether a signal body may be shown to this viewer. */
export function canViewSignal(
  signal: { vipOnly: boolean },
  viewer: { vip: boolean; role?: string } | null,
): boolean {
  if (!signal.vipOnly) return true;
  if (!viewer) return false;
  if (viewer.vip) return true;
  return ['ANALYST', 'ADMIN', 'OWNER', 'SUPPORT'].includes(viewer.role ?? '');
}
