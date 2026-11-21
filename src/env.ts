import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  APP_URL: z.string().url().default('http://localhost:8080'),

  DATABASE_URL: z
    .string()
    .default('postgresql://postgres:postgres@localhost:5432/autopilot?schema=public'),

  JWT_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-please-1234567890'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CORS_ORIGINS: z.string().optional().default(''),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  ADMIN_NAME: z.string().optional(),

  RESEND_API_KEY: z.string().optional().default(''),
  MAIL_FROM: z.string().optional().default('Autopilot Forex <no-reply@autopilotforex.local>'),

  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
  STRIPE_PRICE_VIP_MONTHLY: z.string().optional().default(''),

  INTASEND_PUBLISHABLE_KEY: z.string().optional().default(''),
  INTASEND_SECRET_KEY: z.string().optional().default(''),
  INTASEND_WEBHOOK_CHALLENGE: z.string().optional().default(''),
  INTASEND_SANDBOX: bool(true),

  TWELVE_DATA_API_KEY: z.string().optional().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast, but with a readable message — Railway logs are the only debugger.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// Prisma reads process.env directly; keep the schema default usable locally.
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;

export const isProd = env.NODE_ENV === 'production';

if (isProd && env.JWT_SECRET.startsWith('dev-only')) {
  console.error('JWT_SECRET must be set to a real random value in production.');
  process.exit(1);
}

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const payments = {
  stripeEnabled: Boolean(env.STRIPE_SECRET_KEY),
  mpesaEnabled: Boolean(env.INTASEND_SECRET_KEY && env.INTASEND_PUBLISHABLE_KEY),
  emailEnabled: Boolean(env.RESEND_API_KEY),
  marketDataEnabled: Boolean(env.TWELVE_DATA_API_KEY),
};
