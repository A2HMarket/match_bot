import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { reactTool } from '../../src/tools/react.js';

function deps() {
  return {
    env: { OUTBOUND_UNSURE_ACTION: 'drop' },
    repos: {
      traces: { create: vi.fn(() => Promise.resolve({})) },
      outbound: {
        create: vi.fn((d: unknown, status: string) =>
          Promise.resolve({ id: 'om', status, ...(d as object) }),
        ),
        countSentToTargetSince: vi.fn(() => Promise.resolve(99)),
      },
    },
    evaluateOutbound: vi.fn(),
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
const ctx = (phase: 0 | 1 | 2, over: Partial<MatchContext> = {}): MatchContext => ({
  userId: 'u1',
  chatId: '-1',
  groupId: 'g',
  phase,
  recentReplies: [],
  sourceMessageId: 'm1',
  source: { messageId: '77', userId: '42' },
  ...over,
});
const rc = (c: MatchContext) => ({ context: c }) as never;

describe('react', () => {
  it('reacts to the user message itself, as a reaction row', async () => {
    const d = deps();
    await reactTool(d as never).invoke(rc(ctx(2)), JSON.stringify({ emoji: '👍' }));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reaction',
        target: '-1',
        text: '👍',
        replyToMessageId: '77',
      }),
      'pending',
    );
  });
  it('goes out in phase 1 and 2 without review or Jev, and ignores the daily cap', async () => {
    for (const phase of [1, 2] as const) {
      const d = deps();
      const t = reactTool(d as never);
      expect(await t.needsApproval(rc(ctx(phase)), { emoji: '🙏' }, 'c')).toBe(false);
      await t.invoke(rc(ctx(phase)), JSON.stringify({ emoji: '🙏' }));
      expect(d.evaluateOutbound).not.toHaveBeenCalled();
      expect(d.repos.outbound.countSentToTargetSince).not.toHaveBeenCalled();
      expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
    }
  });
  it('is still only recorded in phase 0', async () => {
    const d = deps();
    await reactTool(d as never).invoke(rc(ctx(0)), JSON.stringify({ emoji: '👍' }));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
  });
  it('only accepts emoji Telegram allows bots to use', async () => {
    const d = deps();
    const out = await reactTool(d as never).invoke(rc(ctx(2)), JSON.stringify({ emoji: '💩' }));
    expect(out).toMatch(/error|invalid/i);
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});
