import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import {
  decideForOutbound,
  disclaimerFor,
  executeOutbound,
} from '../../src/tools/outbound-gate.js';

function deps() {
  return {
    repos: {
      outbound: {
        create: vi.fn((d: unknown, status: string) =>
          Promise.resolve({ id: 'om', status, ...(d as object) }),
        ),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
      },
      traces: { create: vi.fn(() => Promise.resolve({})) },
    },
    jev: { evaluate: vi.fn() },
    evaluateOutbound: vi.fn(() =>
      Promise.resolve({ ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }),
    ),
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
const ctx = (phase: 0 | 1 | 2) =>
  ({
    userId: 'u',
    chatId: '-1',
    groupId: 'g',
    phase,
    recentReplies: [],
    sourceMessageId: 'm1',
    demand: { category: 'man_and_van', confidence: 0.9 },
  }) as never;
const draft = { target: '-1', text: '3 options', supplierSummaries: ['Van Co'], inputRef: 'r1' };

describe('decideForOutbound', () => {
  it('phase 0 -> dry_run without calling jev, still writes a gate trace', async () => {
    const d = deps();
    expect(await decideForOutbound(d as never, ctx(0), draft)).toBe('dry_run');
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
    expect(d.repos.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'gate', phase: 0 }),
    );
  });
  it('phase 1 -> review', async () => {
    expect(await decideForOutbound(deps() as never, ctx(1), draft)).toBe('review');
  });
  it('phase 2 good verdict -> auto', async () => {
    expect(await decideForOutbound(deps() as never, ctx(2), draft)).toBe('auto');
  });
  it('phase 2 jev down -> review (降级方向固定送审)', async () => {
    const d = deps();
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    expect(await decideForOutbound(d as never, ctx(2), draft)).toBe('review');
  });
  it('phase 2 rate limit hit -> review', async () => {
    const d = deps();
    d.repos.outbound.countSentToTargetSince.mockResolvedValueOnce(3);
    expect(await decideForOutbound(d as never, ctx(2), draft)).toBe('review');
  });
  it('caches the decision within a run (needsApproval + execute 只调一次 Jev)', async () => {
    const d = deps();
    const c = ctx(2);
    await decideForOutbound(d as never, c, draft);
    await decideForOutbound(d as never, c, draft);
    expect(d.evaluateOutbound).toHaveBeenCalledTimes(1);
  });
});

describe('executeOutbound', () => {
  it('writes dry_run row in phase 0 and pending row otherwise, with disclaimer appended', async () => {
    const d = deps();
    await executeOutbound(
      d as never,
      ctx(0),
      { ...draft, toolCallId: 'c1', disclaimer: true },
      'dry_run',
    );
    await executeOutbound(d as never, ctx(2), { ...draft, toolCallId: 'c2' }, 'auto');
    const create = d.repos.outbound.create;
    const first = create.mock.calls[0] as unknown[];
    const firstDraft = first[0] as { text: string; toolCallId: string };
    expect(firstDraft.text).toContain('not part of the transaction');
    expect(firstDraft.toolCallId).toBe('c1');
    expect(first[1]).toBe('dry_run');
    expect(create).toHaveBeenNthCalledWith(2, expect.anything(), 'pending');
  });
  it('adds no disclaimer to drafts that recommend nobody (clarifying questions)', async () => {
    const d = deps();
    await executeOutbound(
      d as never,
      ctx(0),
      { ...draft, text: '请问您大概什么时候搬？', supplierSummaries: [] },
      'dry_run',
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toBe('请问您大概什么时候搬？');
  });
  it('localises the disclaimer to a Chinese reply', async () => {
    const d = deps();
    await executeOutbound(
      d as never,
      ctx(0),
      { ...draft, text: '这几个 van 可以参考', disclaimer: true },
      'dry_run',
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toBe('这几个 van 可以参考\n\n请直接联系商家确认报价与档期，我们不参与交易。');
  });
  it('drop writes nothing', async () => {
    const d = deps();
    const r = await executeOutbound(d as never, ctx(2), draft, 'drop');
    expect(r).toContain('not sent');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

describe('disclaimerFor', () => {
  it('prefers the language recorded on the demand', () => {
    expect(disclaimerFor('uk', 'text')).toContain('ми не беремо участі');
    expect(disclaimerFor('pt', 'text')).toContain('não fazemos parte');
  });
  it('detects Chinese from the text when the demand has no language', () => {
    expect(disclaimerFor(undefined, '周六有人有 van 吗')).toContain('我们不参与交易');
  });
  it('falls back to English rather than guessing Russian vs Ukrainian from Cyrillic', () => {
    expect(disclaimerFor(undefined, 'Потрібен фургон')).toContain('not part of the transaction');
  });
  it('falls back to English for a language it has no text for', () => {
    expect(disclaimerFor('fr', 'bonjour')).toContain('not part of the transaction');
  });
});
