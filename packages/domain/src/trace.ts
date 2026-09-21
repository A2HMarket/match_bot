import { z } from 'zod';

export const TRACE_KINDS = ['rule', 'jev', 'agent_run', 'gate'] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/** 每一次判断都要留痕（AGENTS.md §3.3 第 2 条）。costMicro 单位 1e-6 USD。 */
export const decisionTraceInputSchema = z.object({
  kind: z.enum(TRACE_KINDS),
  inputRef: z.string().min(1),
  output: z.unknown(),
  phase: z.number().int().min(0).max(2),
  latencyMs: z.number().int().nonnegative(),
  costMicro: z.number().int().nonnegative().default(0),
});
export type DecisionTraceInput = z.infer<typeof decisionTraceInputSchema>;
