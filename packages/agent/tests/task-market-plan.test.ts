import { taskSchema } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { bindTaskMarketPlan, resolveTaskMarketTarget } from '../src/task-market-plan.js';
import type { MarketPlan } from '../src/market-strategy.js';
import { assessMarketListing } from '../src/market-strategy.js';
import type { MarketListing } from '@matchbot/websearch';

function task() {
  return taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '买桌椅',
    category: 'second_hand',
    status: 'active',
    revision: 0,
    goals: ['desk', 'chair'].map((id, index) => ({
      id,
      title: index ? '办公椅' : '书桌',
      required: true,
      criteria: [
        { id: 'fit', label: '符合条件', strength: 'hard', status: 'unknown', evidenceRefs: [] },
      ],
    })),
    constraints: [
      {
        key: 'area',
        strength: 'hard',
        value: { kind: 'location', area: 'E14' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
      ...['desk', 'chair'].map((goalId, index) => ({
        key: 'budget',
        goalId,
        strength: 'hard',
        value: { kind: 'money', amountPence: index ? 5000 : 7000, unit: 'item' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      })),
    ],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
const modelPlan: MarketPlan = {
  intent: 'second_hand',
  needs: [{ id: 'chair', terms: ['办公椅', 'office chair'] }],
  budget: 999,
  preferences: [],
  requiredArea: ['N1'],
  requiredTerms: [],
  excludeTerms: [],
};
describe('task-bound marketplace plan', () => {
  it('does not treat a rent-only quote as a verified all-in total', () => {
    const t = task();
    t.category = 'housing';
    t.goals = [{ ...t.goals[0]!, id: 'home', title: '一居室' }];
    t.constraints = [
      {
        key: 'budget',
        strength: 'hard',
        value: { kind: 'money', amountPence: 160000, unit: 'month' },
        budgetScope: 'all_in',
        origin: { kind: 'user', sourceMessageId: 'initial' },
      },
    ];
    const plan = bindTaskMarketPlan({ intent: 'housing', needs: [], preferences: [] }, t),
      source: MarketListing = {
        id: 'flat',
        title: '伦敦一居室',
        description: '出租：一居室\n费用：月租£1550，不含账单',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        priceLabel: '£1550/月',
        url: 'https://a2hmarket.ai/listings/flat',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      };
    expect(plan.budgetScope).toBe('all_in');
    expect(assessMarketListing(source, plan).checks.find((c) => c.label === 'budget')?.status).toBe(
      'unknown',
    );
    expect(
      assessMarketListing(
        { ...source, description: source.description.replace('不含账单', '包含账单') },
        plan,
      ).checks.find((c) => c.label === 'budget')?.status,
    ).toBe('met');
  });
  it('excludes an explicitly cat-forbidden source when the user says cats MUST be allowed', () => {
    const t = task();
    t.category = 'housing';
    t.goals = [{ ...t.goals[0]!, id: 'home', title: '一居室' }];
    t.constraints = [
      {
        key: 'pets',
        strength: 'hard',
        value: { kind: 'text', text: '必须允许养猫' },
        origin: { kind: 'user', sourceMessageId: 'initial' },
      },
    ];
    const plan = bindTaskMarketPlan({ intent: 'housing', needs: [], preferences: [] }, t),
      source: MarketListing = {
        id: 'bad',
        title: '伦敦一居室',
        description: '出租：一居室\n要求：不允许养猫或其他宠物',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        priceLabel: '£1500/月',
        url: 'https://a2hmarket.ai/listings/bad',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      };
    expect(assessMarketListing(source, plan).checks.some((c) => c.status === 'mismatch')).toBe(
      true,
    );
  });
  it('rebuilds a saved one-bedroom source plan from a descriptive goal title without rejecting the same property', () => {
    const t = task();
    t.category = 'housing';
    t.counterparty = 'supply';
    t.goals = [{ ...t.goals[0]!, id: 'home', title: '一居室房源' }];
    t.constraints = [
      {
        key: 'budget',
        strength: 'hard',
        value: { kind: 'money', amountPence: 160000, unit: 'month' },
        origin: { kind: 'user', sourceMessageId: 'original' },
      },
      {
        key: 'area',
        strength: 'hard',
        value: { kind: 'location', area: 'Stratford' },
        origin: { kind: 'user', sourceMessageId: 'original' },
      },
    ];
    const plan = bindTaskMarketPlan({ intent: 'housing', needs: [], preferences: [] }, t),
      source: MarketListing = {
        id: 'home',
        title: 'Stratford一居室整租',
        description: '出租：伦敦Stratford一居室整租\n费用：月租£1550\n要求：允许养猫',
        priceLabel: '£1550/月',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        url: 'https://a2hmarket.ai/listings/home',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      };
    expect(assessMarketListing(source, plan).needs).toContain('home');
    expect(plan.requiredArea).toEqual(['Stratford']);
    expect(plan.budget).toBe(1600);
    expect(
      assessMarketListing(
        { ...source, title: 'Stratford studio', description: '出租：Studio开间公寓' },
        plan,
      ).needs,
    ).toEqual([]);
    t.goals[0]!.title = 'one bedroom flat listing';
    t.goals[0]!.searchTerms = ['一居室', 'one bedroom flat'];
    expect(
      assessMarketListing(
        source,
        bindTaskMarketPlan({ intent: 'housing', needs: [], preferences: [] }, t),
      ).needs,
    ).toContain('home');
  });
  it('retains the original offering role across short followups', () => {
    const t = task();
    t.objective = '提供帮带空间并寻找需求方';
    t.counterparty = 'demand';
    expect(resolveTaskMarketTarget(t, '只带衣服')).toBe('BUY');
  });
  it('preserves all unresolved goals and separate caps instead of the model budget', () => {
    const result = bindTaskMarketPlan(modelPlan, task());
    expect(result.needs.map((n) => [n.id, n.budget])).toEqual([
      ['desk', 70],
      ['chair', 50],
    ]);
    expect(result.needs[0]?.terms).toContain('书桌');
    expect(result.needs[1]?.terms).toContain('office chair');
    expect(result.requiredArea).toEqual(['E14']);
    expect(result.budget).toBeUndefined();
  });
  it('does not search a solved item or invent an unspecified budget', () => {
    const t = task();
    t.goals[1]!.userConfirmation = { userId: 'u', sourceMessageId: 'bought', intent: 'achieved' };
    t.constraints = t.constraints.filter((c) => c.key !== 'budget');
    const result = bindTaskMarketPlan(modelPlan, t);
    expect(result.needs.map((n) => n.id)).toEqual(['desk']);
    expect(result.needs[0]?.budget).toBeUndefined();
    expect(result.budget).toBeUndefined();
  });
  it('retains goal-scoped housing conditions and does not apply one item conditions to another', () => {
    const t = task();
    t.constraints.push({
      key: 'feature',
      goalId: 'desk',
      strength: 'hard',
      value: { kind: 'text', text: '实木' },
      origin: { kind: 'user', sourceMessageId: 'm' },
    });
    const split = bindTaskMarketPlan(modelPlan, t);
    expect(split.needs[0]?.rules?.requiredTerms).toContain('实木');
    expect(split.needs[1]?.rules?.requiredTerms).not.toContain('实木');
    t.goals = [t.goals[0]!];
    t.category = 'housing';
    t.constraints = [
      {
        key: 'area',
        goalId: 'desk',
        strength: 'hard',
        value: { kind: 'location', area: 'Stratford' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
    ];
    expect(bindTaskMarketPlan({ ...modelPlan, intent: 'housing' }, t).requiredArea).toEqual([
      'Stratford',
    ]);
  });
  it('retains an offered carry route, exact day and capacity from task conditions', () => {
    const t = task();
    t.category = 'other';
    t.goals = [t.goals[0]!];
    t.constraints = [
      {
        key: 'route_from',
        strength: 'hard',
        value: { kind: 'location', area: '伦敦' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
      {
        key: 'route_to',
        strength: 'hard',
        value: { kind: 'location', area: '上海' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
      {
        key: 'date',
        strength: 'hard',
        value: { kind: 'date_range', from: '2026-11-01', to: '2026-11-01' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
      {
        key: 'capacity',
        strength: 'hard',
        value: { kind: 'text', text: '2公斤' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
    ];
    const result = bindTaskMarketPlan(
      { ...modelPlan, intent: 'carry', route: { from: ['上海'], to: ['伦敦'] } },
      t,
    );
    expect(result.route?.from).toContain('London');
    expect(result.route?.to).toContain('Shanghai');
    expect(result.dateRange).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(result.capacityKg).toBe(2);
  });
});
