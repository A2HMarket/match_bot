import { createJevClient, evaluateInbound } from '@matchbot/jev';
import { createLogger } from '@matchbot/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFixtureFetch, loadJevFixture, recordedLatencies } from '../src/fixture-jev.js';
import { computeDailyMetrics, percentile } from '../src/metrics.js';
import { createMemoryTraces, type MemoryTraces } from '../src/memory-traces.js';
import { summarizeSignals, evaluateSamples, type SampleVerdict } from '../src/replay.js';
import { loadLabeledSamples } from '../src/samples.js';

/**
 * 离线回放：CI 一律走录制的 fixture，不打真实 Jev（AGENTS.md §7 jev 行）。
 * 断言用的是 PoC V4 校准出来的分离度区间而不是逐条数值——`T_IS_DEMAND_ENTER = 0.70`
 * 正是因为正类下限 0.86、负类上限 0.13 之间那条空带才成立。fixture 重录后若滑出这个区间，
 * 说明阈值需要重新校准，这个测试就该红（scripts/poc/v4-jev-inbound/RESULT.md）。
 */
const samples = loadLabeledSamples();
const fixture = loadJevFixture();

let verdicts: SampleVerdict[];
let unavailable: number;
let traces: MemoryTraces;

beforeAll(async () => {
  traces = createMemoryTraces();
  const jev = createJevClient({
    baseUrl: 'http://fixture.invalid',
    apiKey: 'unused',
    model: fixture.requestModel,
    traces,
    logger: createLogger('eval-test', 'silent'),
    fetchImpl: createFixtureFetch({ samples, fixture }),
  });
  ({ verdicts, unavailable } = await evaluateSamples({ samples, evaluateInbound, jev }));
});

describe('labeled inbound fixture', () => {
  it('holds at least the 50 samples AGENTS.md §7 requires, across five languages', () => {
    expect(samples.length).toBeGreaterThanOrEqual(50);
    expect(new Set(samples.map((s) => s.lang)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(samples.map((s) => s.id)).size).toBe(samples.length);
    expect(samples.filter((s) => s.is_demand)).toHaveLength(22);
    expect(samples.filter((s) => s.is_supply)).toHaveLength(5);
  });

  it('keeps placeholder group names explicitly flagged', () => {
    // Brief §4 没有中文群，中文条目的群名是占位的；接入真实中文群前不许它混成真实语料。
    const placeholders = samples.filter((s) => s.group_is_placeholder === true);
    expect(placeholders.length).toBeGreaterThan(0);
    expect(new Set(placeholders.map((s) => s.group))).toEqual(new Set(['@london_chinese_life']));
    for (const s of samples) {
      if (s.group === '@london_chinese_life') expect(s.group_is_placeholder).toBe(true);
    }
  });

  it('has a recorded Jev response for every sample', () => {
    expect(Object.keys(fixture.entries).sort()).toEqual(samples.map((s) => s.id).sort());
  });
});

describe('offline replay against the recorded fixture', () => {
  it('answers every sample without falling back to the unavailable path', () => {
    expect(unavailable).toBe(0);
    expect(verdicts).toHaveLength(samples.length);
  });

  it('keeps the PoC V4 separation band that the thresholds were calibrated on', () => {
    const s = summarizeSignals(verdicts);
    expect(s.isDemand.positive.min).toBeGreaterThanOrEqual(0.86);
    expect(s.isDemand.negative.max).toBeLessThanOrEqual(0.13);
    expect(s.isSupply.positive.min).toBeGreaterThanOrEqual(0.86);
    // category 准确率：V4 实测 0.98，唯一一条分歧出在标注本身可争议的样本上
    expect(s.categoryAccuracy).toBeGreaterThanOrEqual(0.96);
    expect(s.categoryMismatches.length).toBeLessThanOrEqual(2);
  });

  it('reports cost, latency and the pinned model version from the same traces as production', async () => {
    const m = await computeDailyMetrics({ traces, since: new Date(0) });
    // 模型版本一变阈值全部作废，所以它必须能从留痕里读出来（PoC V4「对 P8 的影响」第 2 条）
    expect(m.jevModels).toEqual(['typesafe/jev-1.13-20260917']);
    expect(m.messagesEvaluated).toBe(samples.length);
    expect(m.jevUnavailable).toBe(0);
    // 每条 ~$0.000046（V4 实测 $0.0000457）；留 2 倍余量防问题集悄悄变长
    expect(m.costMicroTotal / samples.length).toBeLessThan(92);
    expect(m.costMicroTotal).toBeGreaterThan(0);
    // 录制时的真实延迟，远低于 2000ms 预算
    expect(percentile(recordedLatencies(fixture), 95)).toBeLessThan(2000);
  });
});
