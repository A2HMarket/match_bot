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
import { taskDeliveryForOutbound } from '../../src/task-outbound.js';
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
  it.each(['找止疼药，现在急用，出不了门', 'Need painkillers urgently, I cannot leave home'])(
    'does not ask an obstacle already supplied: %s',
    async (input) => {
      const { c, d, t } = setup(2);
      bindCurrentRequest(c, input);
      await t.invoke(new RunContext(c), '{}');
      const draft = d.repos.outbound.create.mock.calls[0]?.[0] as { text: string };
      expect(draft.text).not.toMatch(/[?？]/);
    },
  );
  it('does not manufacture a clarification or research checklist after an unsuccessful answer', async () => {
    const { c, d, t } = setup(2);
    bindCurrentRequest(c, '狗岛找止疼药');
    await t.invoke(new RunContext(c), '{}');
    const draft = d.repos.outbound.create.mock.calls[0]?.[0] as { text: string };
    expect(draft.text).not.toMatch(/[?？]|逐项|先核对|先补全|下一步应/);
    expect(draft.text).not.toMatch(/时刻表|先补全哪|https?:|止疼药|狗岛|\d/);
    expect(c.outboundBlocked).toBe(true);
  });
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
    expect(draft.text).not.toMatch(/[?？]/);
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
      expect(body.text).not.toMatch(/[?？]|逐项|先核对|下一步应/);
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

it('keeps an explicitly planned budget question bound to budget rather than inventing another field', () => {
  const { c } = setup(0);
  c.task = taskSchema.parse({
    id: 'task',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '找桌子',
    status: 'active',
    revision: 1,
    goals: [],
    constraints: [],
    evidence: [],
    pendingQuestion: null,
    nextStep: {
      action: 'ask_user',
      owner: 'agent',
      constraintKey: 'budget',
      reason: 'choose an affordable option',
    },
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const text = renderRequestStatus(c)!;
  expect(text).toContain('预算');
  expect(text.match(/[?？]/g)).toHaveLength(1);
  c.execution = {
    userId: 'u',
    messageId: 'm',
    token: '00000000-0000-4000-8000-000000000001',
    fence: 1,
  };
  const delivery = taskDeliveryForOutbound(c, {
    kind: 'notification',
    replyPurpose: 'request_status',
    target: c.chatId,
    text,
    supplierSummaries: [],
    inputRef: c.sourceMessageId,
  });
  expect(delivery?.question).toMatchObject({ constraintKey: 'budget', answerType: 'money' });
  c.task.constraints.push({
    key: 'budget',
    strength: 'hard',
    value: { kind: 'money', amountPence: 5000, unit: 'item' },
    origin: { kind: 'user', sourceMessageId: 'prior' },
  });
  expect(renderRequestStatus(c)).not.toMatch(/[?？]/);
});

it('separates search failure, successful empty research and answer processing failure', () => {
  const { c } = setup(2);
  c.outboundBlocked = false;
  c.informationQueries = ['public query'];
  c.knowledgeSources = [];
  expect(renderRequestStatus(c)).toContain('没搜到');
  c.sourceFailures = ['information:timeout'];
  expect(renderRequestStatus(c)).toContain('没查成');
  c.sourceFailures = [];
  c.knowledgeSources = [
    {
      ref: 'k1',
      title: 'source',
      url: 'https://www.nhs.uk/register',
      text: 'Public information',
      fetchedAt: new Date().toISOString(),
      passages: [],
    },
  ];
  c.answerInputExhausted = true;
  expect(renderRequestStatus(c)).toContain('答复');
  expect(renderRequestStatus(c)).not.toContain('没找到');
});
