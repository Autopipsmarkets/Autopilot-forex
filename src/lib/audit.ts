import type { FastifyRequest } from 'fastify';
import { prisma } from './prisma';

export async function audit(input: {
  request?: FastifyRequest;
  actorId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? input.request?.user?.id ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        meta: input.meta as never,
        ip: input.request?.ip,
      },
    });
  } catch (error) {
    // Auditing must never break the request it is recording.
    input.request?.log.error({ err: error }, 'audit write failed');
  }
}
