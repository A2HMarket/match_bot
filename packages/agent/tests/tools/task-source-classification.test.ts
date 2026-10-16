import { recordTaskProgress, taskSchema } from '@matchbot/domain';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import type { SourceClaim } from '@matchbot/jev';
import { recordTaskProgressTool } from '../../src/tools/record-task-progress.js';
import { createKnowledgeSource } from '../../src/knowledge-evidence.js';

function setup(p: { text: string; positive: number; negative: number; unavailable?: boolean }) {
  const ctx: MatchContext = {
    userId: 'u',
    chatId: 'c',
    groupId: null,
    phase: 2,
    sourceMessageId: 'm',
    recentReplies: [],
    task: taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      objective: '找可养猫一居室',
      category: 'housing',
      counterparty: 'supply',
      status: 'active',
      revision: 1,
      goals: [
        {
          id: 'home',
          title: '一居室',
          required: true,
          criteria: [
            {
              id: 'pets',
              label: '允许养猫',
              constraintKey: 'pets',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'pets',
          strength: 'hard',
          value: { kind: 'text', text: '猫' },
          origin: { kind: 'user', sourceMessageId: 'm' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
    marketTarget: 'SELL',
    marketPlan: {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      preferences: ['猫'],
    },
    marketListings: [
      {
        id: 'flat',
        ref: 'm1',
        title: '伦敦一居室',
        description: '出租：一居室\n要求：' + p.text,
        tags: [],
        tradeType: 'SELL',
        status: 'ON_SALE',
        url: 'https://a2hmarket.ai/listings/flat',
        sourceUrl: null,
        isRepost: false,
        priceLabel: '待确认',
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ],
  };
  const evaluate = vi.fn((request: { state: { claims: SourceClaim[] } }) =>
    Promise.resolve(
      p.unavailable
        ? { ok: false, reason: 'timeout' }
        : {
            ok: true,
            answers: Object.fromEntries(
              request.state.claims.map((claim, index) => [
                'is_supported_' + index,
                {
                  type: 'noul',
                  noul:
                    claim.criterionId === '__source_coherence'
                      ? 0.95
                      : claim.proposedStatus === 'supported'
                        ? p.positive
                        : p.negative,
                },
              ]),
            ),
          },
    ),
  );
  const save = vi.fn(
    (input: { progress: Omit<Parameters<typeof recordTaskProgress>[0], 'task'> }) =>
      Promise.resolve({
        kind: 'applied',
        task: recordTaskProgress({ task: ctx.task!, ...input.progress }),
      }),
  );
  const tool = recordTaskProgressTool({
    jev: { evaluate },
    thresholds: DEFAULT_THRESHOLDS,
    repos: { tasks: { recordProgress: save }, traces: { create: () => Promise.resolve({}) } },
  } as unknown as AgentDeps);
  const run = (ref = 'm1', quote = p.text) =>
    tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        checks: [
          { goalId: 'home', criterionId: 'pets', status: 'unknown', sources: [{ ref, quote }] },
        ],
        next: {
          action: 'deliver',
          goalId: 'home',
          constraintKey: null,
          reason: '给出可核对信息与缺口',
        },
      }),
    );
  return { ctx, evaluate, save, run };
}
describe('source adjudication for generator-unknown checks', () => {
  it('keeps over-budget facts unknown without pretending the source API is down', async () => {
    const { ctx, evaluate, run } = setup({ text: '允许养猫', positive: 0.95, negative: 0.02 });
    ctx.taskSourceReviewedClaims = 96;
    expect(await run()).toContain('"sourceReviewBudgetExhausted":true');
    expect(evaluate).not.toHaveBeenCalled();
    expect(ctx.task?.goals[0]?.criteria[0]?.status).toBe('unknown');
    expect(ctx.sourceFailures).toBeUndefined();
  });
  it('never uses source adjudication to restart a rejected outbound', async () => {
    const { ctx, evaluate, save, run } = setup({
      text: '允许养猫',
      positive: 0.95,
      negative: 0.02,
    });
    ctx.outboundBlocked = true;
    await run();
    expect(evaluate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('does not start another review after the run deadline', async () => {
    const { ctx, evaluate, save, run } = setup({
      text: '允许养猫',
      positive: 0.95,
      negative: 0.02,
    });
    ctx.runDeadlineAt = Date.now() - 1;
    await run();
    expect(evaluate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('retains the user-provided departure area as user context, without borrowing a provider location', async () => {
    const { ctx, run } = setup({ text: '允许养猫', positive: 0.95, negative: 0.02 });
    ctx.task!.constraints.push({
      key: 'travel_origin',
      strength: 'hard',
      value: { kind: 'location', area: 'E14' },
      origin: { kind: 'user', sourceMessageId: 'original' },
    });
    ctx.task!.goals[0]!.criteria.push({
      id: 'origin',
      label: '用户出发区域',
      strength: 'hard',
      constraintKey: 'travel_origin',
      status: 'unknown',
      evidenceRefs: [],
    });
    await run();
    const criterion = ctx.task!.goals[0]!.criteria.find((c) => c.id === 'origin')!;
    expect(criterion.status).toBe('supported');
    const evidence = ctx.task!.evidence.find((e) => e.id === criterion.evidenceRefs[0]);
    expect(evidence).toMatchObject({ kind: 'user_statement', summary: '用户提供的出发地点：E14' });
    expect(evidence?.sourceRef).not.toContain('market:');
    expect(ctx.task!.constraints.find((c) => c.key === 'travel_origin')?.value).toEqual({
      kind: 'location',
      area: 'E14',
    });
  });
  it.each([
    { text: '允许养一只猫，许可会写入租约', positive: 0.95, negative: 0.02, expected: 'supported' },
    { text: '禁止养猫', positive: 0.02, negative: 0.95, expected: 'conflict' },
    { text: '是否允许养猫须书面确认', positive: 0.2, negative: 0.2, expected: 'unknown' },
    { text: '宠物条款存在歧义', positive: 0.95, negative: 0.95, expected: 'unknown' },
    { text: '允许养猫', positive: 0.95, negative: 0.02, unavailable: true, expected: 'unknown' },
  ])('records $expected from validated evidence: $text', async (p) => {
    const { ctx, evaluate, run } = setup(p);
    await run();
    expect(ctx.task?.goals[0]?.criteria[0]?.status).toBe(p.expected);
    expect(ctx.task?.userConfirmation).toBeNull();
    expect(ctx.outboundBlocked).not.toBe(true);
    const calls = evaluate.mock.calls.length;
    await run();
    expect(evaluate).toHaveBeenCalledTimes(calls);
  });
  it('cannot upgrade a general policy or the wrong trade direction into a specific offer fact', async () => {
    const p = { text: '允许养猫', positive: 0.95, negative: 0.02 };
    const a = setup(p);
    a.ctx.marketListings![0]!.tradeType = 'BUY';
    await a.run();
    expect(a.ctx.task?.goals[0]?.criteria[0]?.status).toBe('unknown');
    const b = setup(p);
    b.ctx.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'General policy',
          url: 'https://www.gov.uk/example',
          text: 'Tenants may request permission to keep pets.',
        },
        1,
      ),
    ];
    await b.run('k1', 'Tenants may request permission to keep pets.');
    expect(b.ctx.task?.goals[0]?.criteria[0]?.status).toBe('unknown');
    expect(b.ctx.task?.goals[0]?.criteria[0]?.evidenceRefs).toEqual([]);
  });
});
