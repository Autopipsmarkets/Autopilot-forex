import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env, corsOrigins, isProd } from './env';
import { HttpError } from './lib/errors';
import { checkCsrf } from './lib/auth';
import { prisma } from './lib/prisma';
import { authRoutes } from './modules/auth.routes';
import { publicRoutes } from './modules/public.routes';
import { meRoutes } from './modules/me.routes';
import { billingRoutes } from './modules/billing.routes';
import { adminRoutes } from './modules/admin.routes';
import { webhookRoutes } from './modules/webhooks.routes';

function prettyTransportAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export async function buildApp() {
  // Never depend on a dev-only transport in a production image.
  const usePretty = !isProd && prettyTransportAvailable();

  const app = Fastify({
    logger: usePretty
      ? {
          level: 'debug',
          transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        }
      : { level: isProd ? 'info' : 'debug' },
    trustProxy: true,
    bodyLimit: 1_000_000,
    disableRequestLogging: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / server-to-server
      if (corsOrigins.includes(origin)) return cb(null, true);
      if (!isProd && /^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Stripe-Signature'],
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    max: 180,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health' || req.url === '/ready',
  });

  // CSRF for cookie-authenticated writes. Webhooks authenticate by signature.
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/webhooks/')) return;
    checkCsrf(request);
  });

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch (error) {
      request_log(error);
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Endpoint not found' } });
    }
    return reply.code(404).type('text/html').send('<h1>404 — Not found</h1>');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: 'validation_error',
          message: 'Some fields need attention',
          details: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      });
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Record not found' } });
      }
      if (error.code === 'P2002') {
        return reply.code(409).send({ error: { code: 'conflict', message: 'That value is already taken' } });
      }
    }

    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'unhandled error');

    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'internal_error' : 'request_error',
        message: statusCode >= 500 ? 'Something went wrong on our side' : error.message,
      },
    });
  });

  await app.register(webhookRoutes, { prefix: '' });
  await app.register(authRoutes);
  await app.register(publicRoutes);
  await app.register(meRoutes);
  await app.register(billingRoutes);
  await app.register(adminRoutes);

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'docs'),
    prefix: '/',
    index: ['index.html'],
    maxAge: isProd ? '1h' : 0,
    setHeaders: (res, filePath) => {
      // HTML must revalidate so a deploy is visible immediately.
      if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
    },
  });

  return app;
}

function request_log(error: unknown) {
  console.error('readiness check failed', error);
}
