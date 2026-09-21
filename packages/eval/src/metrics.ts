import type { Repositories } from '@matchbot/db';
import { z } from 'zod';

/** 只需要读的那一个方法；测试注入 stub，生产传 repos.traces。 */
export type TracesReader = Pick<Repositories['traces'], 'listByKind'>;

export interface DailyMetrics {
  /** 过阈进入 Jev 判断的消息条数 = kind=jev 的留痕条数。 */
  messagesEvaluated: number;
  enteredAgent: number;
  interrupted: number;
  dryRuns: number;
  droppedByRule: number;
  costMicroTotal: number;
  costMicroPer1000Messages: number;
  /** kind=gate 的 output.outcome 直方图；agent 侧的门写的是 output.gate，一并计入。 */
  outcomes: Record<string, number>;
  ruleOutcomes: Record<string, number>;
  jevLatencyP50: number;
  jevLatencyP95: number;
  jevUnavailable: number;
  /**
   * Jev 回显的钉死日期版模型（如 typesafe/jev-1.13-20260917）。模型版本一变，
   * PoC V4 校准出来的阈值全部作废，所以指标必须带上它
   * （scripts/poc/v4-jev-inbound/RESULT.md「对 P8 的影响」第 2 条）。
   */
  jevModels: string[];
}

const jevTraceOutputSchema = z.union([
  z.object({ ok: z.literal(true), model: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

const gateTraceOutputSchema = z.object({
  outcome: z.string().optional(),
  gate: z.string().optional(),
});

const TRACE_LIMIT = 100_000;

/** 升序数组的最近秩分位数；空数组返回 0。 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return sortedAsc[idx] ?? 0;
}

function bump(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/** PRD §9 的数据来源只有 decision_traces（AGENTS.md §3.3 第 2 条）。 */
export async function computeDailyMetrics(p: {
  traces: TracesReader;
  since: Date;
}): Promise<DailyMetrics> {
  const [jev, gate, agent, rule] = await Promise.all([
    p.traces.listByKind('jev', p.since, TRACE_LIMIT),
    p.traces.listByKind('gate', p.since, TRACE_LIMIT),
    p.traces.listByKind('agent_run', p.since, TRACE_LIMIT),
    p.traces.listByKind('rule', p.since, TRACE_LIMIT),
  ]);

  const outcomes: Record<string, number> = {};
  for (const g of gate) {
    const parsed = gateTraceOutputSchema.safeParse(g.output);
    bump(
      outcomes,
      (parsed.success ? (parsed.data.outcome ?? parsed.data.gate) : null) ?? 'unknown',
    );
  }
  const ruleOutcomes: Record<string, number> = {};
  for (const r of rule) {
    const parsed = gateTraceOutputSchema.safeParse(r.output);
    bump(ruleOutcomes, (parsed.success ? parsed.data.outcome : null) ?? 'unknown');
  }

  const models = new Set<string>();
  let jevUnavailable = 0;
  const latencies: number[] = [];
  for (const t of jev) {
    latencies.push(t.latencyMs);
    const parsed = jevTraceOutputSchema.safeParse(t.output);
    if (!parsed.success) continue;
    if (parsed.data.ok) models.add(parsed.data.model);
    else jevUnavailable++;
  }
  latencies.sort((a, b) => a - b);

  const costMicroTotal = [...jev, ...gate, ...agent, ...rule].reduce((a, t) => a + t.costMicro, 0);
  const messagesEvaluated = jev.length;
  return {
    messagesEvaluated,
    enteredAgent: outcomes.entered_agent ?? 0,
    interrupted: outcomes.agent_interrupted ?? 0,
    dryRuns: outcomes.agent_completed ?? 0,
    droppedByRule: ruleOutcomes.dropped_by_rule ?? 0,
    costMicroTotal,
    costMicroPer1000Messages: messagesEvaluated
      ? Math.round((costMicroTotal / messagesEvaluated) * 1000)
      : 0,
    outcomes,
    ruleOutcomes,
    jevLatencyP50: percentile(latencies, 50),
    jevLatencyP95: percentile(latencies, 95),
    jevUnavailable,
    jevModels: [...models].sort(),
  };
}
