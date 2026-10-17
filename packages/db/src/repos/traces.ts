import { z } from 'zod';
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
    async summarizeUsage(input: { since: Date; inputRefs: string[] }) {
      const p = z
        .object({ since: z.date(), inputRefs: z.array(z.string().min(1)).max(1000) })
        .parse(input);
      const totals = { calls: 0, inputTokens: 0, outputTokens: 0, missingUsageCalls: 0 };
      if (!p.inputRefs.length) return totals;
      const rows = await prisma.decisionTrace.findMany({
        where: { kind: 'agent_run', createdAt: { gte: p.since }, inputRef: { in: p.inputRefs } },
        select: { output: true },
      });
      const usage = z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      });
      for (const row of rows) {
        totals.calls++;
        const u = usage.safeParse(row.output);
        if (!u.success) {
          totals.missingUsageCalls++;
          continue;
        }
        totals.inputTokens += u.data.inputTokens;
        totals.outputTokens += u.data.outputTokens;
      }
      return totals;
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
