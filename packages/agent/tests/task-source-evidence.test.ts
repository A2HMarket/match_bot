import { taskSchema } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { buildTaskProgress, buildTaskSourceReview } from '../src/task-source-evidence.js';
import type { MatchContext } from '../src/context.js';
import { createKnowledgeSource } from '../src/knowledge-evidence.js';

function context(): MatchContext {
  const task = taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '找一居室',
    category: 'housing',
    counterparty: 'supply',
    status: 'active',
    revision: 1,
    requirementsVersion: 1,
    goals: [
      {
        id: 'home',
        title: '一居室',
        required: true,
        criteria: [
          {
            id: 'budget',
            label: '租金在预算内',
            constraintKey: 'budget',
            strength: 'hard',
            status: 'unknown',
            evidenceRefs: [],
          },
          {
            id: 'pets',
            label: '可养猫',
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
        key: 'budget',
        goalId: 'home',
        strength: 'hard',
        value: { kind: 'money', amountPence: 160000, unit: 'month' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
      {
        key: 'pets',
        goalId: 'home',
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
  });
  return {
    userId: 'u',
    chatId: 'c',
    groupId: 'g',
    phase: 2,
    sourceMessageId: 'm',
    recentReplies: [],
    task,
    marketPlan: {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室', '1b1b'] }],
      budget: 1600,
      preferences: ['猫'],
    },
    marketListings: [
      {
        id: 'flat-a',
        ref: 'm1',
        title: '伦敦一居室',
        description: '出租：Stratford一居室\n价格：£1500/月\n要求：不允许养猫',
        tags: [],
        tradeType: 'SELL',
        status: 'ON_SALE',
        url: 'https://a2hmarket.ai/listings/flat-a',
        sourceUrl: null,
        isRepost: false,
        priceLabel: '£1500/月',
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ],
  };
}
const next = {
  action: 'research' as const,
  goalId: 'home',
  constraintKey: 'pets',
  reason: '继续找明确宠物许可',
};
describe('source-grounded task progress', () => {
  it('invalidates an old source judgement when a refreshed listing no longer contains its evidence', () => {
    const ctx = context();
    ctx.task!.evidence = [
      {
        id: 'old',
        goalId: 'home',
        kind: 'source_excerpt',
        sourceRef: 'market:flat-a',
        summary: '允许养猫',
        observedAt: '2026-10-16T00:00:00Z',
      },
    ];
    ctx.task!.goals[0]!.criteria[1]!.status = 'supported';
    ctx.task!.goals[0]!.criteria[1]!.evidenceRefs = ['old'];
    ctx.marketDetailIds = ['flat-a'];
    const result = buildTaskProgress({ ctx, checks: [], next });
    expect(result.checks).toContainEqual({
      goalId: 'home',
      criterionId: 'pets',
      status: 'unknown',
      evidenceRefs: [],
      conflictingEvidenceRefs: [],
    });
  });
  it('uses the actual item quote for computed budget checks', () => {
    const ctx = context();
    const p = buildTaskProgress({
      ctx,
      checks: [
        {
          goalId: 'home',
          criterionId: 'budget',
          status: 'supported',
          sources: [{ ref: 'm1', quote: null }],
        },
      ],
      next,
    });
    expect(p.evidence[0]?.summary).toContain('£1500/月');
    expect(p.evidence[0]?.entityKey).toBe('market:flat-a');
    expect(p.checks[0]?.status).toBe('supported');
  });
  it('rejects fabricated quotes, unrelated refs, general policy as listing permission and explicit contradictions', () => {
    const ctx = context();
    const call = (ref: string, quote: string) =>
      buildTaskProgress({
        ctx,
        checks: [
          { goalId: 'home', criterionId: 'pets', status: 'supported', sources: [{ ref, quote }] },
        ],
        next,
      });
    expect(() => call('m1', '允许养一只狗')).toThrow('quote');
    expect(() => call('m1', '不允许养猫')).toThrow('contradict');
    expect(() => call('m9', '允许养猫')).toThrow('source');
    ctx.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'Pets policy',
          url: 'https://www.gov.uk/example',
          text: 'Tenants may request permission to keep a cat.',
        },
        1,
      ),
    ];
    expect(() => call('k1', 'Tenants may request permission to keep a cat.')).toThrow(
      'specific offer',
    );
  });
  it('stores unknown gaps and derives the responsible owner without inventing a source outage', () => {
    const ctx = context();
    const p = buildTaskProgress({
      ctx,
      checks: [{ goalId: 'home', criterionId: 'pets', status: 'unknown', sources: [] }],
      next: {
        action: 'ask_user',
        goalId: 'home',
        constraintKey: 'area',
        reason: '是否考虑其他区域',
      },
    });
    expect(p.nextStep.owner).toBe('agent');
    expect(p.evidence).toEqual([]);
    expect(() =>
      buildTaskProgress({
        ctx,
        checks: [],
        next: { action: 'wait_source', goalId: null, constraintKey: null, reason: '服务不可用' },
      }),
    ).toThrow('failure');
  });
});

it('accepts only real read XHS passage IDs returned by the read tool', () => {
  const ctx = context();
  delete ctx.task!.counterparty;
  ctx.task!.category = 'other';
  ctx.xhsNotes = [
    {
      ref: 'x1',
      title: '展览',
      desc: 'Adult admission is free.',
      url: 'https://www.xiaohongshu.com/explore/abc',
      author: 'sample',
      likes: 1,
      isDetailLoaded: true,
    },
  ];
  const args = {
    ctx,
    checks: [
      {
        goalId: 'home',
        criterionId: 'budget',
        status: 'unknown' as const,
        sources: [{ ref: 'x1:p1', quote: 'Adult admission is free.' }],
      },
    ],
    next,
  };
  expect(buildTaskProgress(args).evidence[0]?.summary).toContain('free');
  expect(() =>
    buildTaskProgress({
      ...args,
      checks: [
        { ...args.checks[0]!, sources: [{ ref: 'x1:p99', quote: 'Adult admission is free.' }] },
      ],
    }),
  ).toThrow('unknown or unread');
  ctx.xhsNotes[0]!.isDetailLoaded = false;
  expect(() => buildTaskProgress(args)).toThrow('unknown or unread');
});

it('uses server-owned passage text for null quotes and still creates semantic review claims', () => {
  const ctx = context();
  delete ctx.task!.counterparty;
  ctx.task!.category = 'other';
  ctx.knowledgeSources = [
    createKnowledgeSource(
      {
        title: 'Museum',
        url: 'https://museum.example/exhibition',
        text: 'Adult admission costs twenty pounds.',
      },
      1,
    ),
  ];
  const checks = [
    {
      goalId: 'home',
      criterionId: 'budget',
      status: 'supported' as const,
      sources: [{ ref: 'k1:p1', quote: null }],
    },
  ];
  expect(buildTaskProgress({ ctx, checks, next }).evidence[0]?.summary).toContain('twenty pounds');
  expect(buildTaskSourceReview(ctx, checks).claims).toHaveLength(1);
  const whole = buildTaskProgress({
    ctx,
    checks: [{ ...checks[0]!, sources: [{ ref: 'k1', quote: null }] }],
    next,
  });
  expect(whole.evidence[0]?.summary).toBe(ctx.knowledgeSources[0]!.text);
  expect(
    buildTaskSourceReview(ctx, [{ ...checks[0]!, sources: [{ ref: 'k1', quote: null }] }]).claims,
  ).toHaveLength(1);
});
