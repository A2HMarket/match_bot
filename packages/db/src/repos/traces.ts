import {
  decisionTraceInputSchema,
  type DecisionTraceInput,
  type TraceKind,
} from '@matchbot/domain';
import type { DecisionTrace, PrismaClient } from '../generated/client.js';

export function tracesRepo(prisma: PrismaClient) {
  return {
    create(input: DecisionTraceInput): Promise<DecisionTrace> {
      const t = decisionTraceInputSchema.parse(input);
      return prisma.decisionTrace.create({
        data: {
          kind: t.kind,
          inputRef: t.inputRef,
          output: t.output as object,
          phase: t.phase,
          latencyMs: t.latencyMs,
          costMicro: t.costMicro,
        },
      });
    },
    listByKind(kind: TraceKind, since: Date, limit = 1000): Promise<DecisionTrace[]> {
      return prisma.decisionTrace.findMany({
        where: { kind, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    },
  };
}
