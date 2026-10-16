import { expect, it, vi } from 'vitest';
import { functionCall, ScriptedModel } from '@openai/agents/testing';
import { beginTaskUserTurn, reviseTaskRequirements, taskSchema } from '@matchbot/domain';
import { createLogger, envSchema } from '@matchbot/shared';
import { prepareTaskTurn } from '../src/task-preparation.js';
import type { MatchContext } from '../src/context.js';

it('uses a delivered external reply anchor to continue the older task while another task is open', async () => {
  const activity = taskSchema.parse({
      id: 'activity',
      ownerUserId: 'owner',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找周末初学者羽毛球搭子',
      status: 'waiting_user',
      revision: 0,
      goals: [
        {
          id: 'partner',
          title: '羽毛球搭子',
          required: true,
          criteria: [
            { id: 'subject', label: '活动', strength: 'hard', status: 'unknown', evidenceRefs: [] },
          ],
        },
      ],
      evidence: [],
      pendingQuestion: {
        id: 'question',
        constraintKey: 'max_travel_minutes',
        answerType: 'duration',
        text: '最多接受多久单程通勤？',
        deliveryStatus: 'sent',
        outboundMessageId: 'out',
      },
      blockReason: null,
      delivery: { status: 'sent', level: 'partial', outboundMessageId: 'out' },
      userConfirmation: null,
    }),
    housing = taskSchema.parse({
      ...activity,
      id: 'housing',
      objective: '找房',
      category: 'housing',
      status: 'active',
      pendingQuestion: null,
    });
  const model = new ScriptedModel([
      [
        functionCall(
          'update_task',
          {
            taskRef: 'activity',
            referenceQuote: null,
            goals: [],
            constraints: [
              {
                key: 'max_travel_minutes',
                goalId: null,
                strength: 'hard',
                value: { kind: 'duration', minutes: 30 },
                sourceQuote: '半小时以内',
              },
            ],
            outcome: null,
          },
          { callId: 'answer-question' },
        ),
      ],
    ]),
    planTurn = vi.fn(
      (p: { taskId: string; patch: Parameters<typeof reviseTaskRequirements>[0]['patch'] }) =>
        Promise.resolve({
          kind: 'applied',
          task: beginTaskUserTurn(
            reviseTaskRequirements({
              task: activity,
              source: { messageId: 'input', text: '半小时以内' },
              patch: p.patch,
            }),
          ),
        }),
    ),
    findReplyAnchor = vi.fn().mockResolvedValue(activity),
    ctx: MatchContext = {
      userId: 'owner',
      chatId: '-1',
      groupId: 'group',
      phase: 2,
      sourceMessageId: 'input',
      recentReplies: [],
      replyToMessageId: '101',
    };
  const deps = {
    env: envSchema.parse({
      DATABASE_URL: 'postgresql://synthetic',
      REDIS_URL: 'redis://synthetic',
      DEEPSEEK_API_KEY: 'synthetic',
      JEV_API_KEY: 'synthetic',
      TELEGRAM_BOT_TOKEN: 'synthetic',
      TELEGRAM_OPS_CHAT_ID: '-synthetic',
    }),
    logger: createLogger('test', 'silent'),
    modelProvider: { getModel: () => model },
    repos: {
      tasks: {
        findReplyAnchor,
        findOpenByScope: vi.fn().mockResolvedValue([housing, activity]),
        planTurn,
      },
      traces: { create: vi.fn().mockResolvedValue({}) },
    },
  };
  expect(
    await prepareTaskTurn({
      deps: deps as never,
      ctx,
      input: '半小时以内',
      signal: AbortSignal.timeout(5000),
    }),
  ).toBe(true);
  expect(findReplyAnchor).toHaveBeenCalledWith({
    access: { userId: 'owner', scope: { channel: 'telegram', chatId: '-1' } },
    externalMessageId: '101',
  });
  expect(planTurn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'activity' }));
  expect(ctx.task?.id).toBe('activity');
  expect(ctx.task?.constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: 'max_travel_minutes',
        value: { kind: 'duration', minutes: 30 },
      }),
    ]),
  );
  expect(ctx.task?.pendingQuestion).toBeNull();
  expect(housing.constraints).toEqual([]);
  model.assertComplete();
});
