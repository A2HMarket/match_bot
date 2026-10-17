import { taskSchema } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { buildMarketChoices } from '../src/market-choices.js';
import type { MarketPlan } from '../src/market-strategy.js';
import type { MarketCandidate } from '../src/market-research.js';

const item = (id: string, description: string): MarketCandidate => ({
  id,
  ref: 'm' + id,
  title: '伦敦一居室',
  description,
  tags: [],
  tradeType: 'SELL',
  status: 'ON_SALE',
  url: 'https://a2hmarket.ai/listings/' + id,
  sourceUrl: null,
  isRepost: false,
  priceLabel: '待确认',
  availableFrom: null,
  availableUntil: null,
  createdAt: null,
  sourcePublishedAt: null,
});
const base = () =>
  taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '找房',
    category: 'housing',
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
            id: 'pets',
            label: '允许养猫',
            constraintKey: 'pets',
            strength: 'hard',
            status: 'supported',
            evidenceRefs: ['e'],
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
    evidence: [
      {
        id: 'e',
        goalId: 'home',
        kind: 'source_excerpt',
        sourceRef: 'market:a',
        summary: '允许养猫',
        observedAt: '2026-10-17T00:00:00Z',
      },
    ],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
describe('task-backed offer cards', () => {
  it('excludes a published later start date instead of calling a known conflict an unverified backup', () => {
    const task = base();
    task.constraints.push({
      key: 'move_in_date',
      strength: 'hard',
      value: { kind: 'date_range', from: '2026-11-05', to: '2026-11-05' },
      origin: { kind: 'user', sourceMessageId: 'input' },
    });
    task.goals[0]!.criteria.push({
      id: 'move',
      label: '起租日期',
      constraintKey: 'move_in_date',
      strength: 'hard',
      status: 'unknown',
      evidenceRefs: [],
    });
    const result = buildMarketChoices({
      task,
      plan: { intent: 'housing', needs: [{ id: 'home', terms: ['一居室'] }], preferences: [] },
      candidates: [
        item('a', '出租：一居室\n要求：允许养猫\n入住：2026年11月5日起'),
        item('b', '出租：一居室\n要求：允许养猫\n入住：2026年11月10日起'),
      ],
    });
    expect([...result.primary, ...result.backup].some((row) => row.listing.id === 'b')).toBe(false);
  });
  it('resolves a literal preference gap only with this offer’s validated semantic evidence', () => {
    const task = base();
    task.constraints[0]!.value = { kind: 'text', text: '必须允许养猫' };
    const plan: MarketPlan = {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      preferences: ['必须允许养猫'],
      essentialPreferences: ['必须允许养猫'],
    };
    const result = buildMarketChoices({
      candidates: [
        item('a', '出租：伦敦一居室，允许养猫'),
        item('b', '出租：伦敦一居室，宠物许可未确认'),
      ],
      plan,
      task,
    });
    expect(result.primary.map((row) => row.listing.id)).toEqual(['a']);
    expect(result.backup.map((row) => row.listing.id)).toEqual(['b']);
  });
  it('does not lend a verified permission to another owner and respects a persisted semantic conflict', () => {
    const task = base(),
      plan: MarketPlan = {
        intent: 'housing',
        needs: [{ id: 'home', terms: ['一居室'] }],
        preferences: [],
      };
    const candidates = [
      item('a', '出租：伦敦一居室，允许养猫'),
      item('b', '出租：伦敦一居室，宠物许可未确认'),
    ];
    const result = buildMarketChoices({ candidates, plan, task });
    expect(result.primary.map((row) => row.listing.id)).toEqual(['a']);
    expect(result.backup.map((row) => row.listing.id)).toEqual(['b']);
    expect(result.backup[0]?.essentialMissing).toContain('宠物许可');
    task.goals[0]!.criteria[0]!.conflictingEvidenceRefs = ['negative'];
    task.evidence.push({
      ...task.evidence[0]!,
      id: 'negative',
      sourceRef: 'market:b',
      summary: '拒绝携宠',
    });
    const excluded = buildMarketChoices({ candidates, plan, task });
    expect(excluded.backup).toHaveLength(0);
    expect(excluded.primary.map((row) => row.listing.id)).toEqual(['a']);
    task.goals[0]!.criteria[0]!.status = 'conflict';
    const rejected = buildMarketChoices({ candidates, plan, task });
    expect([...rejected.primary, ...rejected.backup].some((row) => row.listing.id === 'a')).toBe(
      false,
    );
  });
  it('retains the supported item from a bundle while excluding another goal with a source conflict', () => {
    const task = base();
    task.category = 'second_hand';
    task.constraints = [];
    task.goals = ['desk', 'chair'].map((id) => ({
      id,
      title: id === 'desk' ? '书桌' : '办公椅',
      required: true,
      userConfirmation: null,
      criteria: [
        {
          id: 'fit',
          label: '必要功能',
          constraintKey: null,
          strength: 'hard',
          status: id === 'desk' ? 'supported' : 'conflict',
          evidenceRefs: [id],
        },
      ],
    }));
    task.evidence = ['desk', 'chair'].map((id) => ({
      id,
      goalId: id,
      kind: 'source_excerpt',
      sourceRef: 'market:a',
      summary: id,
      observedAt: '2026-10-17T00:00:00Z',
    }));
    const candidate = {
      ...item('a', '- 书桌｜£40\n- 办公椅｜£35\n地点：伦敦E14'),
      title: '伦敦桌椅',
    };
    const plan: MarketPlan = {
      intent: 'second_hand',
      needs: [
        { id: 'desk', terms: ['书桌'] },
        { id: 'chair', terms: ['办公椅'] },
      ],
      preferences: [],
      budget: 50,
    };
    const result = buildMarketChoices({ candidates: [candidate], plan, task });
    expect(result.primary[0]?.assessment.needs).toEqual(['desk']);
    expect(result.primary[0]?.assessment.itemPriceEvidence).toContain('£40');
    expect(result.primary[0]?.assessment.itemPriceEvidence).not.toContain('£35');
  });
});
