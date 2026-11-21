import { PrismaClient, PostCategory, Role } from '@prisma/client';
import { hashPassword, passwordSchema } from '../src/lib/password';
import { env } from '../src/env';

const prisma = new PrismaClient();

async function main() {
  const email = env.ADMIN_EMAIL;
  const password = env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'Set ADMIN_EMAIL and ADMIN_PASSWORD before seeding (see .env.example). ' +
        'These create the first owner account.',
    );
  }

  passwordSchema.parse(password);

  const owner = await prisma.user.upsert({
    where: { email },
    update: { role: Role.OWNER, status: 'ACTIVE', emailVerifiedAt: new Date() },
    create: {
      email,
      fullName: env.ADMIN_NAME ?? 'Owner',
      passwordHash: await hashPassword(password),
      role: Role.OWNER,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  const plans = [
    {
      code: 'vip-monthly',
      name: 'Autopilot VIP',
      description: 'Full signal access, member research and the trading journal.',
      priceCents: 1900,
      currency: 'USD',
      interval: 'MONTH' as const,
      stripePriceId: env.STRIPE_PRICE_VIP_MONTHLY || null,
      features: [
        'Full Gold and forex signal access',
        'Weekly market breakdown',
        'Trading journal tools',
        'Member education sessions',
      ],
      sortOrder: 10,
    },
    {
      code: 'vip-monthly-kes',
      name: 'Autopilot VIP (M-Pesa)',
      description: 'Same membership, billed in Kenyan shillings via M-Pesa.',
      priceCents: 250000,
      currency: 'KES',
      interval: 'MONTH' as const,
      stripePriceId: null,
      features: [
        'Full Gold and forex signal access',
        'Weekly market breakdown',
        'M-Pesa friendly monthly billing',
      ],
      sortOrder: 20,
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: { name: plan.name, description: plan.description, features: plan.features },
      create: plan,
    });
  }

  // A first announcement so the site is never empty.
  await prisma.post.upsert({
    where: { slug: 'welcome-to-autopilot-forex' },
    update: {},
    create: {
      slug: 'welcome-to-autopilot-forex',
      title: 'Welcome to Autopilot Forex',
      category: PostCategory.ANNOUNCEMENT,
      excerpt: 'What the platform does, and what it deliberately does not do.',
      body:
        '# Welcome\n\nAutopilot Forex is an education and research platform.\n\n' +
        'We publish structured market analysis, signals with explicit invalidation levels, ' +
        'and risk-management material. We do not hold client funds and we do not promise returns.\n\n' +
        'Trading involves substantial risk of loss.',
      published: true,
      publishedAt: new Date(),
      authorId: owner.id,
    },
  });

  await prisma.setting.upsert({
    where: { key: 'site' },
    update: {},
    create: {
      key: 'site',
      value: {
        supportEmail: email,
        mpesaNumber: '',
        tradingHours: 'Mon–Fri, 08:00–20:00 EAT',
      },
    },
  });

  console.log(`Seed complete. Owner account: ${owner.email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
