import { expect, it, vi } from 'vitest';
import { RunContext } from '@openai/agents';
import { recordTaskProgress, taskSchema, assessTaskReadiness } from '@matchbot/domain';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { recordTaskProgressTool } from '../../src/tools/record-task-progress.js';
import type { MatchContext } from '../../src/context.js';

it('records an explicit calendar term without a noisy semantic vote, while leaving the unverified subject and life goal open', async () => {
  const ctx: MatchContext = {
    userId: 'u',
    chatId: 'c',
    groupId: null,
    sourceMessageId: 'input',
    phase: 0,
    recentReplies: [],
    task: taskSchema.parse({
      id: 'task',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      objective: '找一居室',
      category: 'housing',
      counterparty: 'supply',
      status: 'active',
      revision: 0,
      goals: [
        {
          id: 'home',
          title: '一居室',
          required: true,
          criteria: [
            {
              id: 'subject',
              label: '一居室',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
            {
              id: 'date',
              label: '当前入住日期',
              constraintKey: 'move_in_date',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'move_in_date',
          strength: 'hard',
          value: { kind: 'date_range', from: '2026-11-05', to: '2026-11-05' },
          origin: { kind: 'user', sourceMessageId: 'input' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
    marketPlan: { intent: 'housing', needs: [{ id: 'home', terms: ['一居室'] }], preferences: [] },
    marketListings: [
      {
        id: 'flat',
        ref: 'm1',
        title: '一居室',
        description: '出租：一居室\n入住：2026年11月5日起',
        priceLabel: '待确认',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        url: 'https://a2hmarket.ai/listings/flat',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: null,
        sourcePublishedAt: null,
      },
    ],
  };
  const evaluate = vi.fn().mockRejectedValue(new Error('calendar equality needs no model vote')),
    recordProgress = vi.fn(
      (p: { progress: Omit<Parameters<typeof recordTaskProgress>[0], 'task'> }) =>
        Promise.resolve({
          kind: 'applied',
          task: recordTaskProgress({ task: ctx.task!, ...p.progress }),
        }),
    ),
    traces = { create: vi.fn().mockResolvedValue({}) },
    tool = recordTaskProgressTool({
      thresholds: DEFAULT_THRESHOLDS,
      jev: { evaluate },
      repos: { tasks: { recordProgress }, traces },
    } as never);
  await tool.invoke(
    new RunContext(ctx),
    JSON.stringify({
      checks: [
        {
          goalId: 'home',
          criterionId: 'date',
          status: 'unknown',
          sources: [{ ref: 'm1', quote: '入住：2026年11月5日起' }],
        },
      ],
      next: {
        action: 'deliver',
        goalId: 'home',
        constraintKey: null,
        reason: '交付已确认的来源日期与剩余缺口',
      },
    }),
  );
  expect(evaluate).not.toHaveBeenCalled();
  expect(ctx.task?.goals[0]?.criteria.find((c) => c.id === 'date')?.status).toBe('supported');
  expect(ctx.task?.goals[0]?.criteria.find((c) => c.id === 'subject')?.status).toBe('unknown');
  expect(assessTaskReadiness(ctx.task!).ready).toBe(false);
  expect(ctx.task?.userConfirmation).toBeNull();
  expect(traces.create).toHaveBeenCalledWith(
    expect.objectContaining<{ output: unknown }>({
      output: expect.objectContaining({ result: 'explicit_calendar_fact_checked' }),
    }),
  );
});
