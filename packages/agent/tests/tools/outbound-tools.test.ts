import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { askClarificationTool } from '../../src/tools/ask-clarification.js';
import { notifyUserTool } from '../../src/tools/notify-user.js';
import { pushLeadTool } from '../../src/tools/push-lead.js';
import { replyInGroupTool } from '../../src/tools/reply-in-group.js';

const VAN = { id: 'a', name: 'Van Co', roughPrice: '£40/h', telegram: '@vanco' };
const NO_TG = { id: 'b', name: 'NoTelegram Ltd', roughPrice: null, telegram: null };

function deps(goodVerdict = true) {
  return {
    env: { TELEGRAM_OPS_CHAT_ID: '-100ops' },
    repos: {
      outbound: {
        create: vi.fn((d: unknown, status: string) =>
          Promise.resolve({ id: 'om', status, ...(d as object) }),
        ),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
      },
      traces: { create: vi.fn(() => Promise.resolve({})) },
      suppliers: {
        findByIds: vi.fn((ids: string[]) =>
          Promise.resolve([VAN, NO_TG].filter((s) => ids.includes(s.id))),
        ),
      },
    },
    jev: { evaluate: vi.fn() },
    evaluateOutbound: vi.fn(() =>
      Promise.resolve(
        goodVerdict
          ? { ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }
          : { ok: true, worthReplying: 1.5, languageOk: 0.95, mentionsUnverified: 0 },
      ),
    ),
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function makeCtx(phase: 0 | 1 | 2): MatchContext {
  return {
    userId: 'u1',
    chatId: '-1',
    groupId: 'g',
    phase,
    recentReplies: [],
    sourceMessageId: 'm1',
    demand: { category: 'man_and_van', confidence: 0.9 },
  };
}
const rc = (ctx: MatchContext) => ({ context: ctx }) as never;

const cases = [
  {
    name: 'reply_in_group',
    make: replyInGroupTool,
    args: { text: 'Two options for you', supplierIds: ['a'] },
    target: '-1',
  },
  {
    name: 'notify_user',
    make: notifyUserTool,
    args: { text: 'Found a van for you' },
    target: 'u1',
  },
  {
    name: 'ask_clarification',
    make: askClarificationTool,
    args: { question: 'Which date?', missingFields: ['whenAt'] },
    target: '-1',
  },
  {
    name: 'push_lead',
    make: pushLeadTool,
    args: { supplierId: 'a', demandSummary: '8 boxes, E14 to SE1, Sunday' },
    target: '@vanco',
  },
] as const;

describe.each(cases)('$name (出站工具四阶段用例)', ({ make, args, target }) => {
  it('phase 0: no approval, execute writes dry_run', async () => {
    const d = deps();
    const t = make(d as never);
    const ctx = makeCtx(0);
    expect(await t.needsApproval(rc(ctx), args as never, 'c1')).toBe(false);
    await t.invoke(rc(ctx), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ target }),
      'dry_run',
    );
  });

  it('phase 1: needsApproval interrupts; post-approval execute writes pending', async () => {
    const d = deps();
    const t = make(d as never);
    const ctx = makeCtx(1);
    expect(await t.needsApproval(rc(ctx), args as never, 'c1')).toBe(true);
    await t.invoke(rc(ctx), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
  });

  it('phase 2 good verdict: no approval, execute writes pending (auto)', async () => {
    const d = deps(true);
    const t = make(d as never);
    const ctx = makeCtx(2);
    expect(await t.needsApproval(rc(ctx), args as never, 'c1')).toBe(false);
    await t.invoke(rc(ctx), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
  });

  it('phase 2 weak verdict: needsApproval interrupts', async () => {
    const d = deps(false);
    const t = make(d as never);
    expect(await t.needsApproval(rc(makeCtx(2)), args as never, 'c1')).toBe(true);
  });
});

describe('reply_in_group supplier guard', () => {
  it('rejects supplier ids that find_suppliers never returned', async () => {
    const d = deps();
    const t = replyInGroupTool(d as never);
    const out = await t.invoke(
      rc(makeCtx(1)),
      JSON.stringify({ text: 'x', supplierIds: ['nope'] }),
    );
    expect(out).toContain('unknown supplier id');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

describe('push_lead without supplier telegram', () => {
  it('routes the lead to the ops chat with a manual note', async () => {
    const d = deps();
    const t = pushLeadTool(d as never);
    const out = await t.invoke(
      rc(makeCtx(0)),
      JSON.stringify({ supplierId: 'b', demandSummary: '8 boxes, E14 to SE1' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ target: '-100ops' }),
      'dry_run',
    );
    expect(out).toContain('ops will send manually');
  });
});
