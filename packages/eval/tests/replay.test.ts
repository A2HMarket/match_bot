import type { InboundVerdict } from '@matchbot/jev';
import { describe, expect, it, vi } from 'vitest';
import { replayInbound, summarizeSignals, type InboundDecider } from '../src/replay.js';
import type { LabeledSample } from '../src/samples.js';

const samples: LabeledSample[] = [
  {
    id: 's0',
    lang: 'en',
    group: 'g',
    text: 'need a van',
    is_demand: true,
    is_supply: false,
    category: 'man_and_van',
  },
  {
    id: 's1',
    lang: 'en',
    group: 'g',
    text: 'lol',
    is_demand: false,
    is_supply: false,
    category: 'other',
  },
];

function verdict(p: Partial<InboundVerdict>): InboundVerdict {
  return {
    ok: true,
    isDemand: 0,
    isSupply: 0,
    category: 'other',
    categoryConfidence: 0.9,
    urgency: 0,
    hasLocation: 0,
    isSensitive: 0,
    isMoveEvent: 0,
    ...p,
  };
}

/** 单测里的门只是个桩：这里验的是打分口径，真实规则在 packages/gating 自己的表驱动测试里。 */
const fakeGate: InboundDecider<{ enter: number }> = (v, t) =>
  v.isDemand >= t.enter ? { action: 'enter_agent' } : { action: 'drop' };

describe('replayInbound', () => {
  it('computes precision/recall/category accuracy against labels', async () => {
    const evaluateInbound = vi.fn((_c: unknown, p: { text: string }) =>
      Promise.resolve(
        p.text === 'need a van'
          ? verdict({ isDemand: 0.9, category: 'man_and_van' })
          : verdict({ isDemand: 0.1 }),
      ),
    );
    const r = await replayInbound({
      samples,
      evaluateInbound,
      jev: {} as never,
      decide: fakeGate,
      thresholds: { enter: 0.7 },
    });
    expect(r).toMatchObject({
      n: 2,
      precision: 1,
      recall: 1,
      categoryAccuracy: 1,
      silenceCorrect: 1,
      tp: 1,
      fp: 0,
      fn: 0,
      tn: 1,
      unavailable: 0,
    });
    expect(r.actions).toEqual({ enter_agent: 1, drop: 1 });
    expect(r.rows.map((x) => x.id)).toEqual(['s0', 's1']);
  });

  it('passes the label id as inputRef and always replays in phase 0', async () => {
    const evaluateInbound = vi.fn(() => Promise.resolve(verdict({})));
    await replayInbound({
      samples: [samples[0]!],
      evaluateInbound,
      jev: {} as never,
      decide: fakeGate,
      thresholds: { enter: 0.7 },
    });
    expect(evaluateInbound).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ inputRef: 'eval:s0', phase: 0, recentTexts: [] }),
    );
  });

  it('counts jev unavailability separately and keeps it out of the denominators', async () => {
    const evaluateInbound = vi.fn((_c: unknown, p: { text: string }) =>
      Promise.resolve(
        p.text === 'lol'
          ? { ok: false as const, reason: 'timeout' }
          : verdict({ isDemand: 0.9, category: 'man_and_van' }),
      ),
    );
    const r = await replayInbound({
      samples,
      evaluateInbound,
      jev: {} as never,
      decide: fakeGate,
      thresholds: { enter: 0.7 },
    });
    expect(r).toMatchObject({ n: 1, unavailable: 1, precision: 1, recall: 1, tp: 1 });
    // 没有样本被判沉默：分母为 0 时按 1 报，不能报 NaN
    expect(r.silenceCorrect).toBe(1);
  });

  it('flags a false positive and a missed demand', async () => {
    const evaluateInbound = vi.fn((_c: unknown, p: { text: string }) =>
      Promise.resolve(
        p.text === 'lol'
          ? verdict({ isDemand: 0.95 })
          : verdict({ isDemand: 0.2, category: 'man_and_van' }),
      ),
    );
    const r = await replayInbound({
      samples,
      evaluateInbound,
      jev: {} as never,
      decide: fakeGate,
      thresholds: { enter: 0.7 },
    });
    expect(r).toMatchObject({ tp: 0, fp: 1, fn: 1, tn: 0, precision: 0, recall: 0 });
    expect(r.silenceCorrect).toBe(0);
  });
});

describe('summarizeSignals', () => {
  it('separates gold positives from negatives without any threshold', () => {
    const s = summarizeSignals([
      { sample: samples[0]!, verdict: verdict({ isDemand: 0.9, category: 'man_and_van' }) },
      { sample: samples[1]!, verdict: verdict({ isDemand: 0.02 }) },
    ]);
    expect(s.isDemand.positive).toMatchObject({ n: 1, min: 0.9, max: 0.9 });
    expect(s.isDemand.negative).toMatchObject({ n: 1, min: 0.02, max: 0.02 });
    expect(s.categoryAccuracy).toBe(1);
    expect(s.categoryMismatches).toEqual([]);
  });
});
