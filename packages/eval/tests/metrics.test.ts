import { describe, expect, it } from 'vitest';
import { computeDailyMetrics, percentile } from '../src/metrics.js';
import { createMemoryTraces } from '../src/memory-traces.js';

const JEV_MODEL = 'typesafe/jev-1.13-20260917';

describe('percentile', () => {
  it('uses nearest rank and tolerates the empty set', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([5], 95)).toBe(5);
  });
});

describe('computeDailyMetrics', () => {
  it('derives density, cost and outcome counts from traces', async () => {
    const traces = createMemoryTraces();
    for (const outcome of ['entered_agent', 'dropped_by_jev', 'agent_interrupted']) {
      await traces.create({
        kind: 'gate',
        inputRef: outcome,
        output: { outcome },
        phase: 0,
        latencyMs: 0,
        costMicro: 0,
      });
    }
    for (const latencyMs of [324, 408]) {
      await traces.create({
        kind: 'jev',
        inputRef: `m${latencyMs}`,
        output: { ok: true, model: JEV_MODEL },
        phase: 0,
        latencyMs,
        costMicro: 17,
      });
    }
    await traces.create({
      kind: 'agent_run',
      inputRef: 'r1',
      output: {},
      phase: 0,
      latencyMs: 1200,
      costMicro: 900,
    });

    const m = await computeDailyMetrics({ traces, since: new Date(0) });
    expect(m).toMatchObject({
      messagesEvaluated: 2,
      enteredAgent: 1,
      interrupted: 1,
      costMicroTotal: 934,
    });
    expect(m.costMicroPer1000Messages).toBe(467000);
    expect(m.jevLatencyP50).toBe(324);
    expect(m.jevLatencyP95).toBe(408);
    // 阈值只对某个模型版本有效，所以版本必须出现在指标里（PoC V4 结论第 2 条）
    expect(m.jevModels).toEqual([JEV_MODEL]);
  });

  it('counts rule-layer drops and jev unavailability, and stays at zero on an empty window', async () => {
    const traces = createMemoryTraces();
    await traces.create({
      kind: 'rule',
      inputRef: 'm1',
      output: { outcome: 'dropped_by_rule', reason: 'blacklist' },
      phase: 0,
      latencyMs: 0,
      costMicro: 0,
    });
    await traces.create({
      kind: 'jev',
      inputRef: 'm2',
      output: { ok: false, reason: 'timeout' },
      phase: 0,
      latencyMs: 3000,
      costMicro: 0,
    });
    // agent 侧的门写的是 output.gate 而不是 output.outcome，不能算成 unknown
    await traces.create({
      kind: 'gate',
      inputRef: 'm3',
      output: { gate: 'agent_noop', reason: 'chit-chat' },
      phase: 0,
      latencyMs: 0,
      costMicro: 0,
    });

    const m = await computeDailyMetrics({ traces, since: new Date(0) });
    expect(m.droppedByRule).toBe(1);
    expect(m.jevUnavailable).toBe(1);
    expect(m.jevModels).toEqual([]);
    expect(m.outcomes).toEqual({ agent_noop: 1 });
    expect(m.costMicroPer1000Messages).toBe(0);

    const empty = await computeDailyMetrics({ traces, since: new Date(Date.now() + 60_000) });
    expect(empty).toMatchObject({
      messagesEvaluated: 0,
      costMicroTotal: 0,
      costMicroPer1000Messages: 0,
      jevLatencyP50: 0,
    });
  });
});
