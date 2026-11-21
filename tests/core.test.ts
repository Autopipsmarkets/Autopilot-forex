import { describe, expect, it } from 'vitest';
import { hashPassword, passwordSchema, verifyPassword } from '../src/lib/password';
import { signAccessToken, verifyAccessToken, sha256, randomToken } from '../src/lib/tokens';
import { canViewSignal, isSubscriptionActive } from '../src/lib/subscription';
import { paginate, HttpError } from '../src/lib/errors';

describe('password policy', () => {
  it('rejects short and weak passwords', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('password123').success).toBe(false);
    expect(passwordSchema.safeParse('alllettersonly').success).toBe(false);
  });

  it('accepts a reasonable password', () => {
    expect(passwordSchema.safeParse('GoldDesk#2026').success).toBe(true);
  });

  it('hashes and verifies', async () => {
    const hash = await hashPassword('GoldDesk#2026');
    expect(hash).not.toContain('GoldDesk');
    expect(await verifyPassword(hash, 'GoldDesk#2026')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips claims', () => {
    const token = signAccessToken({ id: 'u1', email: 'a@b.com', role: 'USER' });
    const claims = verifyAccessToken(token);
    expect(claims?.sub).toBe('u1');
    expect(claims?.role).toBe('USER');
  });

  it('rejects tampered tokens', () => {
    const token = signAccessToken({ id: 'u1', email: 'a@b.com', role: 'USER' });
    expect(verifyAccessToken(`${token}x`)).toBeNull();
    expect(verifyAccessToken('not-a-token')).toBeNull();
  });

  it('hashes refresh tokens deterministically', () => {
    const token = randomToken(32);
    expect(sha256(token)).toBe(sha256(token));
    expect(sha256(token)).not.toBe(token);
  });
});

describe('vip entitlement', () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);

  it('requires an active subscription inside its period', () => {
    expect(isSubscriptionActive({ status: 'ACTIVE', currentPeriodEnd: future })).toBe(true);
    expect(isSubscriptionActive({ status: 'ACTIVE', currentPeriodEnd: past })).toBe(false);
    expect(isSubscriptionActive({ status: 'CANCELLED', currentPeriodEnd: future })).toBe(false);
    expect(isSubscriptionActive(null)).toBe(false);
  });

  it('gates vip-only signals but never free ones', () => {
    expect(canViewSignal({ vipOnly: true }, null)).toBe(false);
    expect(canViewSignal({ vipOnly: true }, { vip: false, role: 'USER' })).toBe(false);
    expect(canViewSignal({ vipOnly: true }, { vip: true })).toBe(true);
    expect(canViewSignal({ vipOnly: true }, { vip: false, role: 'ANALYST' })).toBe(true);
    expect(canViewSignal({ vipOnly: false }, null)).toBe(true);
  });
});

describe('pagination', () => {
  it('clamps hostile input', () => {
    expect(paginate('-5', '9999')).toMatchObject({ page: 1, pageSize: 100, skip: 0 });
    expect(paginate('3', '10')).toMatchObject({ page: 3, pageSize: 10, skip: 20 });
  });
});

describe('http errors', () => {
  it('carries status and code', () => {
    const err = new HttpError(403, 'forbidden', 'nope');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('forbidden');
  });
});
