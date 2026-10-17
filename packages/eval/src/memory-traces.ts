import { z } from 'zod';
import type { DecisionTrace, Repositories } from '@matchbot/db';
import { decisionTraceInputSchema, type TraceKind } from '@matchbot/domain';

export type MemoryTraces = Repositories['traces'] & { readonly rows: readonly DecisionTrace[] };

/**
 * 回放时用的内存版 decision_traces：不落库，但形状与仓储一致，
 * 因此 computeDailyMetrics 可以原样吃回放产生的留痕（成本、模型版本、延迟）。
 */
export function createMemoryTraces(): MemoryTraces {
  const rows: DecisionTrace[] = [];
  let seq = 0;
  return {
    rows,
    create(input) {
      const t = decisionTraceInputSchema.parse(input);
      const row: DecisionTrace = {
        id: `mem-${String(++seq).padStart(6, '0')}`,
        kind: t.kind,
        inputRef: t.inputRef,
        // Prisma 的 Json 列在内存里原样保留；调用方只读不写。
        output: t.output as DecisionTrace['output'],
        phase: t.phase,
        latencyMs: t.latencyMs,
        costMicro: t.costMicro,
        createdAt: new Date(),
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    summarizeUsage({ since, inputRefs }) {
      const usage = z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      });
      const totals = { calls: 0, inputTokens: 0, outputTokens: 0, missingUsageCalls: 0 };
      for (const row of rows.filter(
        (r) => r.kind === 'agent_run' && r.createdAt >= since && inputRefs.includes(r.inputRef),
      )) {
        totals.calls++;
        const parsed = usage.safeParse(row.output);
        if (!parsed.success) totals.missingUsageCalls++;
        else {
          totals.inputTokens += parsed.data.inputTokens;
          totals.outputTokens += parsed.data.outputTokens;
        }
      }
      return Promise.resolve(totals);
    },
    listByKind(kind: TraceKind, since: Date, limit = 1000) {
      return Promise.resolve(
        rows.filter((r) => r.kind === kind && r.createdAt >= since).slice(0, limit),
      );
    },
  };
}
