import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createLogger } from '@matchbot/shared';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import { bindCurrentRequest } from '../../src/current-request.js';
import { replyRequestStatusTool } from '../../src/tools/reply-request-status.js';
import { makeOutboundTool } from '../../src/tools/make-outbound-tool.js';
import { z } from 'zod';
import { renderRequestStatus } from '../../src/request-status.js';
import { taskSchema } from '@matchbot/domain';
function setup(phase: 0 | 1 | 2, available = true) {
  const c: MatchContext = {
    userId: 'u',
    chatId: '-1',
    groupId: null,
    phase,
    sourceMessageId: 'm',
    recentReplies: [],
    outboundBlocked: true,
    isRequestStatusRun: true,
  };
  bindCurrentRequest(c, 'E14想找周末羽毛球搭子，我是初学者，有适合新手的吗？');
  const d = {
    answerRequests: true,
    env: { OUTBOUND_UNSURE_ACTION: 'drop' },
    thresholds: DEFAULT_THRESHOLDS,
    logger: createLogger('test', 'silent'),
    jev: {},
    evaluateOutbound: vi
      .fn()
      .mockResolvedValue(
        available
          ? { ok: true, worthReplying: 0.1, mentionsUnverified: 0.99, languageOk: 1 }
          : { ok: false, reason: 'timeout' },
      ),
    repos: {
      traces: { create: vi.fn().mockResolvedValue({}) },
      outbound: {
        create: vi.fn().mockResolvedValue({ id: 'o' }),
        countSentToTargetSince: vi.fn().mockResolvedValue(0),
      },
    },
  };
  return { c, d, t: replyRequestStatusTool(d as unknown as AgentDeps) };
}
describe('reply_request_status', () => {
  it('does not ask for a travel limit the selected task already knows', async () => {
    const { c, d, t } = setup(2);
    c.task = taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找新手羽毛球',
      status: 'active',
      revision: 1,
      goals: [],
      constraints: [
        {
          key: 'max_travel_minutes',
          strength: 'hard',
          value: { kind: 'duration', minutes: 30 },
          origin: { kind: 'user', sourceMessageId: 'm' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    await t.invoke(new RunContext(c), '{}');
    const draft = d.repos.outbound.create.mock.calls[0]?.[0] as { text: string };
    expect(draft.text).not.toContain('最多能接受多久');
    expect(draft.text).toContain('通勤范围');
    expect(draft.text).not.toMatch(/30|E14|https?:/);
    expect(c.outboundBlocked).toBe(true);
  });
  it.each([0, 2] as const)(
    'phase %i sends only a fixed status, retaining the blocked recommendation',
    async (phase) => {
      const { c, d, t } = setup(phase),
        rc = new RunContext(c);
      expect(await t.needsApproval(rc, {}, 'status')).toBe(false);
      await t.invoke(rc, JSON.stringify({ text: 'invented club £99 guaranteed' }));
      expect(d.repos.outbound.create).toHaveBeenCalledOnce();
      const body = d.repos.outbound.create.mock.calls[0]?.[0] as { text: string };
      expect(body.text).toContain('单程通勤');
      expect(body.text).not.toContain('invented');
      expect(c.outboundBlocked).toBe(true);
      await t.invoke(rc, '{}');
      expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    },
  );
  it('phase 1 requires approval without writing outbound', async () => {
    const { c, d, t } = setup(1);
    expect(await t.needsApproval(new RunContext(c), {}, 'status')).toBe(true);
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not auto-send when Jev is unavailable', async () => {
    const { c, d, t } = setup(2, false);
    await t.invoke(new RunContext(c), '{}');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not reuse a rejected recommendation decision for the same fixed status text', async () => {
    const { c, d, t } = setup(2);
    c.outboundBlocked = false;
    const text = renderRequestStatus(c) ?? '';
    const original = makeOutboundTool(d as unknown as AgentDeps, {
      name: 'original',
      description: 'test',
      parameters: z.object({}),
      toDraft: () =>
        Promise.resolve({
          kind: 'recommendation' as const,
          target: c.chatId,
          text,
          supplierSummaries: [],
          inputRef: c.sourceMessageId,
        }),
    });
    await original.invoke(new RunContext(c), '{}');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    await t.invoke(new RunContext(c), '{}');
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    expect(c.outboundBlocked).toBe(true);
  });
  it('cannot use a fixed status to send to another group', async () => {
    const { c, d } = setup(2);
    const forged = makeOutboundTool(d as unknown as AgentDeps, {
      name: 'fake_target',
      description: 'test',
      isRequestStatus: true,
      parameters: z.object({}),
      toDraft: () =>
        Promise.resolve({
          kind: 'notification' as const,
          replyPurpose: 'request_status' as const,
          target: '-another-group',
          text: renderRequestStatus(c) ?? '',
          supplierSummaries: [],
          inputRef: c.sourceMessageId,
        }),
    });
    await forged.invoke(new RunContext(c), '{}');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('cannot label free-form text as a verified status', async () => {
    const { c, d } = setup(2);
    const forged = makeOutboundTool(d as unknown as AgentDeps, {
      name: 'fake',
      description: 'test',
      isRequestStatus: true,
      parameters: z.object({}),
      toDraft: () =>
        Promise.resolve({
          kind: 'notification',
          replyPurpose: 'request_status' as const,
          target: c.chatId,
          text: 'An invented club is guaranteed to accept beginners.',
          supplierSummaries: [],
          inputRef: c.sourceMessageId,
        }),
    });
    await forged.invoke(new RunContext(c), '{}');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});
