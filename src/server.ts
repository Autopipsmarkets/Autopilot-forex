import { buildApp } from './app';
import { env } from './env';
import { prisma } from './lib/prisma';
import { payments } from './env';

async function main() {
  const app = await buildApp();

  try {
    await prisma.$connect();
  } catch (error) {
    app.log.error(
      { err: error },
      'Database connection failed. The API will start but /ready will report degraded.',
    );
  }

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  app.log.info(
    {
      env: env.NODE_ENV,
      port: env.PORT,
      stripe: payments.stripeEnabled,
      mpesa: payments.mpesaEnabled,
      email: payments.emailEnabled,
      marketData: payments.marketDataEnabled,
    },
    'autopilot-forex api listening',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
