import { taskSchema } from '@matchbot/domain';
import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import { readTaskSourcesTool } from '../../src/tools/read-task-sources.js';

function setup() {
  const ctx: MatchContext = {
    userId: 'u',
    chatId: 'c',
    groupId: null,
    phase: 0,
    sourceMessageId: 'm',
    recentReplies: [],
    task: taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      category: 'second_hand',
      counterparty: 'supply',
      objective: '找书桌',
      status: 'active',
      revision: 1,
      goals: [
        {
          id: 'desk',
          title: '书桌',
          required: true,
          criteria: [
            { id: 'fit', label: '找到书桌', strength: 'hard', status: 'unknown', evidenceRefs: [] },
          ],
        },
      ],
      constraints: [],
      evidence: [
        {
          id: 'e',
          goalId: 'desk',
          kind: 'source_excerpt',
          sourceRef: 'market:desk-1',
          summary: '历史报价£40，需重新核对',
          observedAt: '2026-10-16T00:00:00Z',
        },
      ],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
  };
  const detail = vi.fn(() =>
    Promise.resolve({
      id: 'desk-1',
      title: '伦敦书桌',
      description: '书桌已售出',
      tags: [],
      tradeType: 'SELL',
      status: 'SOLD',
      url: 'https://a2hmarket.ai/listings/desk-1',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '£40',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    }),
  );
  const deps = {
    marketSearch: { detail },
    repos: { traces: { create: vi.fn(() => Promise.resolve({})) } },
  } as unknown as AgentDeps;
  return { ctx, detail, tool: readTaskSourcesTool(deps) };
}
describe('read_task_sources', () => {
  it('records failed refreshes without treating historical evidence as a current offer or retrying indefinitely', async () => {
    const { ctx, detail, tool } = setup();
    detail.mockRejectedValueOnce(new Error('synthetic timeout'));
    const args = JSON.stringify({ sources: ['market:desk-1'] });
    const result = JSON.parse(await tool.invoke(new RunContext(ctx), args)) as {
      current: unknown[];
      failures: string[];
    };
    expect(result.current).toEqual([]);
    expect(result.failures).toEqual(['market:desk-1']);
    expect(ctx.sourceFailures).toContain('task_sources:detail_unavailable');
    await tool.invoke(new RunContext(ctx), args);
    expect(detail).toHaveBeenCalledOnce();
  });
  it('refreshes only saved public sources, reuses current refs and counts detail reads', async () => {
    const { ctx, detail, tool } = setup();
    const result = await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({ sources: ['market:desk-1'] }),
    );
    expect(result).toContain('SOLD');
    expect(ctx.marketListings?.[0]?.ref).toBe('m1');
    expect(ctx.marketPlan?.needs[0]?.id).toBe('desk');
    expect(ctx.marketDetailIds).toEqual(['desk-1']);
    await tool.invoke(new RunContext(ctx), JSON.stringify({ sources: ['market:desk-1'] }));
    expect(detail).toHaveBeenCalledOnce();
    expect(ctx.task?.goals[0]?.criteria[0]?.status).toBe('unknown');
  });
  it('denies foreign sources, cross-scope tasks, exhausted reads and outbound refusal', async () => {
    const { ctx, detail, tool } = setup();
    const call = (sources = ['market:desk-1']) =>
      tool.invoke(new RunContext(ctx), JSON.stringify({ sources }));
    expect(await call(['market:someone-else'])).toContain('saved');
    ctx.task!.scope.chatId = 'elsewhere';
    expect(await call()).toContain('scope');
    ctx.task!.scope.chatId = 'c';
    ctx.marketDetailIds = Array.from({ length: 8 }, (_, i) => 'used-' + i);
    expect(await call()).toContain('budget');
    ctx.outboundBlocked = true;
    expect(await call()).toContain('declined');
    expect(detail).not.toHaveBeenCalled();
  });
});
