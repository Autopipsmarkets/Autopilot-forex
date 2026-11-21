import { hash, verify, Algorithm } from '@node-rs/argon2';
import { z } from 'zod';

const options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

const WEAK = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'letmein123',
  'autopilot',
  'forex12345',
  'admin12345',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long')
  .refine((v) => !WEAK.has(v.toLowerCase()), 'Choose a less common password')
  .refine((v) => /[a-zA-Z]/.test(v) && /[^a-zA-Z]/.test(v), 'Mix letters with numbers or symbols');

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, options);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain, options);
  } catch {
    return false;
  }
}

/** Constant-ish time dummy verification so unknown emails are not trivially enumerable. */
export async function burnPasswordTime(): Promise<void> {
  await verify('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000', 'x').catch(
    () => false,
  );
}
