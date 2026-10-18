import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { taskDeliveryForOutbound } from '../src/task-outbound.js';
import { renderRequestStatus } from '../src/request-status.js';
import type { MatchContext } from '../src/context.js';
import type { OutboundDraftInput } from '../src/tools/outbound-gate.js';

function context(): MatchContext {
  return {
    userId: 'owner',
    chatId: '-1',
    groupId: 'group',
    phase: 2,
    sourceMessageId: 'input',
    execution: {
      userId: 'owner',
      messageId: 'input',
      token: '00000000-0000-4000-8000-000000000001',
      fence: 1,
    },
    recentReplies: [],
    task: taskSchema.parse({
      id: 'task',
      ownerUserId: 'owner',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找搭子',
      status: 'active',
      revision: 1,
      requirementsVersion: 1,
      goals: [],
      evidence: [],
      pendingQuestion: null,
      nextStep: {
        action: 'ask_user',
        owner: 'agent',
        constraintKey: 'max_travel_minutes',
        reason: '确定单程通勤范围',
      },
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
  };
}
const draft = (): OutboundDraftInput => ({
  kind: 'clarification',
  target: '-1',
  text: '最多接受多久单程通勤？',
  inputRef: 'input',
  supplierSummaries: [],
});
describe('server task outbound metadata', () => {
  it('does not lose a practical question just because an explanatory sentence follows it', () => {
    const ctx = context();
    ctx.task!.nextStep = { action: 'deliver', owner: 'agent', reason: 'partial sources' };
    const d = {
      ...draft(),
      kind: 'recommendation' as const,
      text: '你是现在急用，还是出门不方便？这会影响找哪种渠道。',
    };
    expect(() => taskDeliveryForOutbound(ctx, d)).toThrow('Record');
    ctx.task!.nextStep = {
      action: 'ask_user',
      owner: 'agent',
      constraintKey: 'custom:access_difficulty',
      reason: 'feasible access',
    };
    expect(taskDeliveryForOutbound(ctx, d)?.question?.constraintKey).toBe(
      'custom:access_difficulty',
    );
  });
  it('binds the question to the current task and original short text, without claiming it was delivered', () => {
    const ctx = context(),
      d = {
        ...draft(),
        text: '最多接受多久单程通勤？\n\ngenerated cards and sources',
        taskQuestionText: '最多接受多久单程通勤？',
      };
    expect(taskDeliveryForOutbound(ctx, d)).toEqual({
      id: 'task',
      requirementsVersion: 1,
      level: 'partial',
      question: {
        constraintKey: 'max_travel_minutes',
        answerType: 'duration',
        text: '最多接受多久单程通勤？',
      },
    });
    expect(ctx.task?.pendingQuestion).toBeNull();
    expect(ctx.task?.delivery.status).toBe('none');
  });
  it('does not mark a question delivered when rendering truncated it out of the actual message', () => {
    expect(() =>
      taskDeliveryForOutbound(context(), {
        ...draft(),
        text: '只保留了前面的建议…',
        taskQuestionText: '前面的建议很长，最多接受多久单程通勤？',
      }),
    ).toThrow('actual');
  });
  it('requires a missing-field plan for a question, and rejects already supplied fields or oversized questions', () => {
    const ctx = context();
    ctx.task!.nextStep = null;
    expect(() => taskDeliveryForOutbound(ctx, draft())).toThrow('Record');
    ctx.task!.nextStep = {
      action: 'ask_user',
      owner: 'agent',
      constraintKey: 'max_travel_minutes',
      reason: '范围',
    };
    expect(() => taskDeliveryForOutbound(ctx, { ...draft(), text: '问'.repeat(501) })).toThrow(
      'short',
    );
    ctx.task!.constraints = [
      {
        key: 'max_travel_minutes',
        strength: 'hard',
        value: { kind: 'duration', minutes: 30 },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
    ];
    expect(() => taskDeliveryForOutbound(ctx, draft())).toThrow('already answered');
  });
  it.each([
    'budget',
    'date',
    'move_in_date',
    'area',
    'travel_origin',
    'route_from',
    'route_to',
    'self_collect',
    'custom:scope',
  ])('records the expected answer type for %s', (key) => {
    const ctx = context();
    ctx.task!.nextStep!.constraintKey = key;
    const expected =
      key === 'budget'
        ? 'money'
        : key.includes('date')
          ? 'date'
          : ['area', 'travel_origin', 'route_from', 'route_to'].includes(key)
            ? 'location'
            : key === 'self_collect'
              ? 'boolean'
              : 'text';
    expect(
      taskDeliveryForOutbound(ctx, { ...draft(), text: '请补充这一项。' })?.question?.answerType,
    ).toBe(expected);
  });
  it('derives a canonical fixed-status question without inventing a field or dropping known constraints', () => {
    const ctx = context();
    ctx.isRequestStatusRun = true;
    ctx.currentRequest = {
      text: '找书桌',
      isActionable: true,
      demand: { category: 'second_hand', confidence: 1, lang: 'zh' },
    };
    const text = renderRequestStatus(ctx)!;
    expect(
      taskDeliveryForOutbound(ctx, {
        ...draft(),
        kind: 'notification',
        replyPurpose: 'request_status',
        text,
      })?.question,
    ).toMatchObject({ constraintKey: 'max_travel_minutes', answerType: 'duration' });
    ctx.task!.constraints.push({
      key: 'max_travel_minutes',
      strength: 'hard',
      value: { kind: 'duration', minutes: 30 },
      origin: { kind: 'user', sourceMessageId: 'first' },
    });
    ctx.task!.nextStep = { action: 'deliver', owner: 'agent', reason: '解释核验缺口' };
    expect(
      taskDeliveryForOutbound(ctx, {
        ...draft(),
        kind: 'notification',
        replyPurpose: 'request_status',
        text: renderRequestStatus(ctx)!,
      })?.question,
    ).toBeUndefined();
  });
  it('never attaches a task to another conversation, reaction, lead, foreign owner or unfenced caller', () => {
    const ctx = context();
    expect(taskDeliveryForOutbound(ctx, { ...draft(), target: 'another-chat' })).toBeUndefined();
    expect(taskDeliveryForOutbound(ctx, { ...draft(), kind: 'reaction' })).toBeUndefined();
    expect(taskDeliveryForOutbound(ctx, { ...draft(), kind: 'lead' })).toBeUndefined();
    ctx.task!.ownerUserId = 'other';
    expect(taskDeliveryForOutbound(ctx, draft())).toBeUndefined();
    ctx.task!.ownerUserId = 'owner';
    delete ctx.execution;
    expect(taskDeliveryForOutbound(ctx, draft())).toBeUndefined();
  });
});

describe('P33 live question regressions', () => {
  it.each([
    '问的时候可以直接说：「HP那台打印机还在吗？型号是什么？」',
    '先问卖家一句“这台支持 WiFi 吗？”型号还未知。',
    'You can ask the seller: "Does it support WiFi?"',
    '来源：[NHS](https://www.nhs.uk/register?practice=e14)',
  ])('does not turn third-party examples or URL punctuation into user questions: %s', (text) => {
    const ctx = context();
    ctx.task!.nextStep = { action: 'deliver', owner: 'agent', reason: 'honest partial evidence' };
    expect(
      taskDeliveryForOutbound(ctx, { ...draft(), kind: 'recommendation', text })?.question,
    ).toBeUndefined();
  });
  it.each(['你最多接受多久单程通勤？', '想问你：「你预算多少？」', '你现在不能出门吗？'])(
    'still rejects an unplanned actual question: %s',
    (text) => {
      const ctx = context();
      ctx.task!.nextStep = { action: 'deliver', owner: 'agent', reason: 'answer' };
      expect(() =>
        taskDeliveryForOutbound(ctx, { ...draft(), kind: 'recommendation', text }),
      ).toThrow('Record');
    },
  );
});

it('replays the actual P33 rejected quoted-question draft without treating it as a user question', () => {
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/p33-quoted-question.json', import.meta.url), 'utf8'),
  ) as Array<{ text: string }>;
  expect(fixtures).toHaveLength(1);
  for (const fixture of fixtures) {
    const ctx = context();
    ctx.task!.nextStep = { action: 'deliver', owner: 'agent', reason: 'partial evidence' };
    expect(
      taskDeliveryForOutbound(ctx, { ...draft(), kind: 'recommendation', text: fixture.text })
        ?.question,
    ).toBeUndefined();
  }
});

it('checks the actual personal question length rather than rejecting a useful long answer', () => {
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/p34-long-answer-question.json', import.meta.url), 'utf8'),
  ) as Array<{ text: string }>;
  expect(fixtures.length).toBeGreaterThan(0);
  for (const fixture of fixtures) {
    const ctx = context();
    ctx.task!.nextStep = {
      action: 'ask_user',
      owner: 'agent',
      constraintKey: 'custom:gp_subarea',
      reason: 'choose practice catchment',
    };
    const result = taskDeliveryForOutbound(ctx, {
      ...draft(),
      kind: 'recommendation',
      text: fixture.text,
      taskQuestionText: fixture.text,
    });
    expect(result?.question?.text.length).toBeLessThan(500);
    expect(fixture.text).toContain(result?.question?.text);
  }
});
