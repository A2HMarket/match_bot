import { expect, it, vi } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import type { AgentDeps, MatchContext } from '../src/context.js';
import { refreshTaskSourceMemory } from '../src/task-source-refresh.js';
import { restoreExecutionCheckpoint } from '../src/execution-checkpoint.js';

function fixture() {
  const ctx: MatchContext = {
    userId: 'u',
    chatId: 'c',
    groupId: null,
    phase: 0,
    sourceMessageId: 'm',
    recentReplies: [],
    taskUpdate: { kind: 'continued' },
    task: taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      category: 'second_hand',
      counterparty: 'supply',
      objective: '找桌椅',
      status: 'active',
      revision: 1,
      goals: ['desk', 'chair'].map((id) => ({
        id,
        title: id === 'desk' ? '书桌' : '办公椅',
        required: true,
        criteria: [
          {
            id: 'source',
            label: '物品来源',
            strength: 'hard',
            status: 'unknown',
            evidenceRefs: [],
          },
        ],
      })),
      evidence: ['desk', 'chair'].map((id) => ({
        id: 'e-' + id,
        goalId: id,
        kind: 'source_excerpt',
        sourceRef: 'market:' + id,
        summary: '历史信息',
        observedAt: '2026-10-16T00:00:00Z',
      })),
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
  };
  const detail = vi.fn((id: string) =>
    Promise.resolve({
      id,
      title: '伦敦' + id,
      description: '更新后的公开信息',
      tradeType: 'SELL',
      status: 'ON_SALE',
      tags: [],
      priceLabel: '£45',
      url: 'https://a2hmarket.ai/listings/' + id,
      sourceUrl: null,
      isRepost: false,
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    }),
  );
  const deps = {
    taskRequests: true,
    marketSearch: { detail },
    repos: { traces: { create: vi.fn(() => Promise.resolve({})) } },
  } as unknown as AgentDeps;
  return {
    ctx,
    deps,
    detail,
    run: () => refreshTaskSourceMemory({ deps, ctx, input: '继续找', agentVersion: 'test' }),
  };
}

it('refreshes saved public sources for unresolved goals before generation and shares the detail cache', async () => {
  const { ctx, detail, run } = fixture();
  await run();
  expect(detail).toHaveBeenCalledTimes(2);
  expect(ctx.marketListings?.map((row) => row.description)).toEqual([
    '更新后的公开信息',
    '更新后的公开信息',
  ]);
  await run();
  expect(detail).toHaveBeenCalledTimes(2);
  expect(ctx.task!.status).toBe('active');
});
it('does not query completed goals, a declined run or a foreign task', async () => {
  const { ctx, detail, run } = fixture();
  ctx.task!.goals[1]!.userConfirmation = {
    userId: 'u',
    sourceMessageId: 'done',
    intent: 'achieved',
  };
  await run();
  expect(detail).toHaveBeenCalledWith('desk');
  expect(detail).toHaveBeenCalledTimes(1);
  ctx.marketDetailIds = [];
  ctx.outboundBlocked = true;
  await run();
  ctx.outboundBlocked = false;
  ctx.task!.scope.chatId = 'elsewhere';
  await run();
  expect(detail).toHaveBeenCalledTimes(1);
});
it('records source failures instead of treating saved excerpts as fresh evidence', async () => {
  const { ctx, detail, run } = fixture();
  detail.mockRejectedValueOnce(new Error('synthetic outage'));
  await run();
  expect(ctx.sourceFailures).toContain('task_sources:detail_unavailable');
  expect(ctx.marketListings).toHaveLength(1);
  expect(ctx.marketDetailIds).toHaveLength(2);
});
it('checkpoints automatic reads encrypted and resumes without repeating them, rejecting a lost fence', async () => {
  const { ctx, deps, detail, run } = fixture();
  ctx.execution = { userId: 'u', messageId: 'm', token: 'lease', fence: 1 };
  const saveCheckpoint = vi.fn((_p: { snapshot: string }) => Promise.resolve(true));
  Object.assign(deps, { env: { SNAPSHOT_KEY: 'synthetic-refresh-checkpoint-key' } });
  Object.assign(deps.repos, { executions: { saveCheckpoint } });
  await run();
  const snapshot = saveCheckpoint.mock.calls[0]![0].snapshot;
  expect(snapshot).not.toContain('更新后的公开信息');
  const resumed = restoreExecutionCheckpoint(deps, ctx, '继续找', snapshot, 'test');
  expect(resumed.marketListings).toHaveLength(2);
  await refreshTaskSourceMemory({ deps, ctx: resumed, input: '继续找', agentVersion: 'test' });
  expect(detail).toHaveBeenCalledTimes(2);
  ctx.marketDetailIds = [];
  saveCheckpoint.mockResolvedValue(false);
  await expect(run()).rejects.toThrow('execution checkpoint fence lost');
});
it('bounds a slow source by the request deadline while retaining other successful reads', async () => {
  vi.useFakeTimers();
  try {
    const { ctx, detail, run } = fixture();
    const get = detail.getMockImplementation()!;
    detail.mockImplementation((id) => (id === 'chair' ? new Promise<never>(() => {}) : get(id)));
    ctx.runDeadlineAt = Date.now() + 50;
    const pending = run();
    await vi.advanceTimersByTimeAsync(55);
    await pending;
    expect(ctx.marketListings).toHaveLength(1);
    expect(ctx.marketListings![0]!.id).toBe('desk');
    expect(ctx.sourceFailures).toContain('task_sources:detail_unavailable');
  } finally {
    vi.useRealTimers();
  }
});
it('never reads after task completion, the deadline or an exhausted shared detail budget', async () => {
  const { ctx, detail, run } = fixture();
  ctx.task!.status = 'completed';
  await run();
  ctx.task!.status = 'active';
  ctx.runDeadlineAt = Date.now() - 1;
  await run();
  delete ctx.runDeadlineAt;
  ctx.marketDetailIds = Array.from({ length: 8 }, (_, i) => 'other-' + i);
  await run();
  expect(detail).not.toHaveBeenCalled();
});
