import { describe, it, expect, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { xhsReadNotesTool } from '../../src/tools/xhs-read-notes.js';
const card = (n = 1) => ({
  ref: `x${n}`,
  title: `展${n}`,
  desc: '搜索卡片摘要',
  author: '作者',
  likes: 1,
  url: `https://www.xiaohongshu.com/explore/n${n}`,
  isDetailLoaded: false,
});
const context = (over: Partial<MatchContext> = {}): MatchContext => ({
  userId: 'u',
  chatId: 'c',
  groupId: null,
  phase: 0,
  sourceMessageId: 'm',
  recentReplies: [],
  xhsNotes: [card()],
  ...over,
});
const deps = () => ({
  repos: { traces: { create: vi.fn(() => Promise.resolve({})) } },
  logger: { warn: vi.fn() },
  xhsSearch: {
    find: vi.fn(),
    readNote: vi.fn((n: ReturnType<typeof card>) =>
      Promise.resolve({ ...n, desc: '完整介绍\n票价£20', isDetailLoaded: true }),
    ),
  },
});
const rc = (c: MatchContext) => ({ context: c }) as never;
describe('selective XHS reading', () => {
  it('uses the last remaining read instead of rejecting an entire two-ref batch', async () => {
    const d = deps(),
      c = context({
        xhsNotes: Array.from({ length: 13 }, (_, i) => card(i + 1)),
        xhsDetailRefs: Array.from({ length: 11 }, (_, i) => `x${i + 1}`),
      });
    const out = JSON.parse(
      await xhsReadNotesTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['x12', 'x13'] })),
    ) as { budgetLimitedRefs: string[] };
    expect(d.xhsSearch.readNote).toHaveBeenCalledOnce();
    expect(c.xhsDetailRefs).toHaveLength(12);
    expect(out.budgetLimitedRefs).toEqual(['x13']);
  });
  it('hydrates selected refs, preserves identities, returns new passage IDs and caches repeats', async () => {
    const d = deps(),
      c = context(),
      t = xhsReadNotesTool(d as never);
    const out = JSON.parse(await t.invoke(rc(c), JSON.stringify({ refs: ['x1'] }))) as {
      notes: Array<{ ref: string; passages: Array<{ text: string }> }>;
    };
    expect(out.notes[0]?.passages.map((p) => p.text)).toEqual(['完整介绍', '票价£20']);
    expect(c.xhsNotes?.[0]).toMatchObject({ ref: 'x1', url: card().url, isDetailLoaded: true });
    expect(c.xhsDetailRefs).toEqual(['x1']);
    await t.invoke(rc(c), JSON.stringify({ refs: ['x1'] }));
    expect(d.xhsSearch.readNote).toHaveBeenCalledOnce();
  });
  it('rejects unknown refs and any request after an outbound decline', async () => {
    for (const c of [context(), context({ outboundBlocked: true })]) {
      const d = deps();
      await xhsReadNotesTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['x9'] }));
      expect(d.xhsSearch.readNote).not.toHaveBeenCalled();
    }
  });
  it('counts failed attempts once and never substitutes another note', async () => {
    const d = deps(),
      c = context(),
      t = xhsReadNotesTool(d as never);
    d.xhsSearch.readNote.mockResolvedValueOnce({
      ...card(2),
      desc: '别的笔记',
      isDetailLoaded: true,
    });
    const out = await t.invoke(rc(c), JSON.stringify({ refs: ['x1'] }));
    expect(out).toContain('x1');
    expect(c.xhsNotes?.[0]?.desc).toBe('搜索卡片摘要');
    await t.invoke(rc(c), JSON.stringify({ refs: ['x1'] }));
    expect(d.xhsSearch.readNote).toHaveBeenCalledOnce();
  });
  it('caps full-note reads at twelve independently of the search budget', async () => {
    const d = deps(),
      c = context({ xhsNotes: Array.from({ length: 13 }, (_, i) => card(i + 1)) }),
      t = xhsReadNotesTool(d as never);
    for (const refs of [
      ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'],
      ['x7', 'x8', 'x9', 'x10', 'x11', 'x12'],
    ])
      await t.invoke(rc(c), JSON.stringify({ refs }));
    expect(await t.invoke(rc(c), JSON.stringify({ refs: ['x13'] }))).toContain('budget exhausted');
    expect(d.xhsSearch.readNote).toHaveBeenCalledTimes(12);
  });
});
