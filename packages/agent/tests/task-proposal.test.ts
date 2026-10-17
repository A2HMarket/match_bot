import { taskSchema } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { normalizeTaskPatch, taskPatchProposalSchema } from '../src/task-proposal.js';

const task = taskSchema.parse({
  id: 't',
  ownerUserId: 'u',
  scope: { channel: 'telegram', chatId: 'c' },
  objective: '买桌子',
  status: 'active',
  revision: 0,
  goals: [
    {
      id: 'desk',
      title: '书桌',
      required: true,
      criteria: [
        { id: 'fit', label: '有合适候选', strength: 'hard', status: 'unknown', evidenceRefs: [] },
      ],
    },
  ],
  constraints: [
    {
      key: 'budget',
      goalId: 'desk',
      strength: 'hard',
      value: { kind: 'money', amountPence: 5000, unit: 'item' },
      origin: { kind: 'user', sourceMessageId: 'old' },
    },
  ],
  evidence: [],
  pendingQuestion: null,
  blockReason: null,
  delivery: { status: 'none', level: 'none' },
  userConfirmation: null,
});
describe('task proposal normalization', () => {
  it('retains the amount but updates explicit all-in scope even if the proposal only mentions bills', () => {
    const housing = taskSchema.parse({
      ...task,
      category: 'housing',
      constraints: [
        {
          key: 'budget',
          strength: 'hard',
          value: { kind: 'money', amountPence: 160000, unit: 'month' },
          budgetScope: 'rent_only',
          origin: { kind: 'user', sourceMessageId: 'old' },
        },
      ],
    });
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'bills',
          goalId: null,
          strength: 'preference',
          value: { kind: 'text', text: '包bills' },
          sourceQuote: '最好包bills',
        },
      ],
    });
    const result = normalizeTaskPatch({
      input,
      task: housing,
      text: '最好包bills，但总预算不能增加',
    });
    expect(result?.constraints.find((c) => c.key === 'budget')).toMatchObject({
      budgetScope: 'all_in',
      value: { kind: 'money', amountPence: 160000, unit: 'month' },
      sourceQuote: '总预算不能增加',
    });
    expect(
      normalizeTaskPatch({ input, task: housing, text: '最好包bills' })?.constraints.some(
        (c) => c.key === 'budget',
      ),
    ).toBe(false);
  });
  it('compiles a source-level subject check while preserving an explicit identity-verification requirement', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [
        {
          id: 'home',
          title: '一居室',
          required: true,
          sourceQuote: '一居室',
          criteria: [
            {
              id: 'listing',
              label: '为可联系房东或中介的真实出租房源信息',
              strength: 'hard',
              constraintKey: null,
            },
            {
              id: 'verified',
              label: '必须核实房东身份',
              strength: 'hard',
              constraintKey: 'custom:verified_landlord',
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'custom:verified_landlord',
          goalId: 'home',
          strength: 'hard',
          value: { kind: 'boolean', value: true },
          sourceQuote: '核实房东身份',
        },
      ],
    });
    const patch = normalizeTaskPatch({ input, task, text: '找一居室，并且必须核实房东身份' });
    expect(patch?.goals[0]?.criteria[0]).toMatchObject({
      id: 'listing',
      label: '来源描述的对象或邀约：一居室',
      constraintKey: null,
    });
    expect(patch?.goals[0]?.criteria[1]).toMatchObject({
      constraintKey: 'custom:verified_landlord',
      strength: 'hard',
    });
    expect(patch?.constraints[0]?.value).toEqual({ kind: 'boolean', value: true });
  });
  it('does not invent or move a date from an unrelated pet requirement', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'date_range', from: '2026-12-05', to: '2026-12-05' },
          sourceQuote: '猫一定要能养',
        },
      ],
    });
    expect(() => normalizeTaskPatch({ input, task, text: '猫一定要能养' })).toThrow('date');
    const dated = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'date_range', from: '2026-12-05', to: '2026-12-05' },
          sourceQuote: '11月5日入住',
        },
      ],
    });
    expect(
      normalizeTaskPatch({
        input: dated,
        task,
        text: '11月5日入住',
        now: new Date('2026-10-17T12:00:00Z'),
      })?.constraints[0]?.value,
    ).toEqual({ kind: 'date_range', from: '2026-11-05', to: '2026-11-05' });
  });
  it('normalizes text locations and unambiguous housing dates into executable values', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'travel_origin',
          goalId: null,
          strength: 'hard',
          value: { kind: 'text', text: 'E14' },
          sourceQuote: '我住E14',
        },
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'text', text: '11月入住' },
          sourceQuote: '11月入住',
        },
      ],
    });
    const patch = normalizeTaskPatch({
      input,
      task,
      text: '我住E14，11月入住',
      now: new Date('2026-10-17T12:00:00Z'),
    });
    expect(patch?.constraints[0]?.value).toEqual({ kind: 'location', area: 'E14' });
    expect(patch?.constraints[1]?.value).toEqual({
      kind: 'date_range',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    const later = taskSchema.parse(task);
    later.constraints.push({
      key: 'move_in_date',
      strength: 'hard',
      value: { kind: 'date_range', from: '2027-11-01', to: '2027-11-30' },
      origin: { kind: 'user', sourceMessageId: 'old' },
    });
    const refined = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'text', text: '11月5日入住' },
          sourceQuote: '11月5日入住',
        },
      ],
    });
    expect(
      normalizeTaskPatch({
        input: refined,
        task: later,
        text: '11月5日入住',
        now: new Date('2026-10-17T12:00:00Z'),
      })?.constraints[0]?.value,
    ).toEqual({ kind: 'date_range', from: '2027-11-05', to: '2027-11-05' });
  });
  it('treats an unspecified optional travel check as an information gap, without inventing a duration', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [
        {
          id: 'desk',
          title: '书桌',
          required: true,
          sourceQuote: '找书桌',
          criteria: [
            {
              id: 'travel',
              label: '核对通勤方便程度',
              strength: 'preference',
              constraintKey: 'max_travel_minutes',
            },
          ],
        },
      ],
      constraints: [],
    });
    const patch = normalizeTaskPatch({ input, task, text: '找书桌' });
    expect(patch?.goals[0]?.criteria[0]?.constraintKey).toBeNull();
    expect(patch?.constraints).toEqual([]);
  });
  it('normalizes duplicate origin fields without treating where someone lives as an offer boundary', () => {
    const constraints = ['area', 'travel_origin'].map((key) => ({
      key,
      goalId: null,
      strength: 'hard',
      value: { kind: 'location', area: 'E14' },
      sourceQuote: '我住E14',
    }));
    const input = taskPatchProposalSchema.parse({ goals: [], constraints });
    expect(
      normalizeTaskPatch({ input, task, text: '我住E14，找桌子' })?.constraints.map((c) => c.key),
    ).toEqual(['travel_origin']);
    expect(
      normalizeTaskPatch({ input, task, text: '我住E14，只在E14找桌子' })?.constraints.map(
        (c) => c.key,
      ),
    ).toEqual(['area', 'travel_origin']);
  });
  it('checks explicit prices against the quoted amount and permits grounded relative changes', () => {
    const input = (quote: string, amountPence: number) =>
      taskPatchProposalSchema.parse({
        goals: [],
        constraints: [
          {
            key: 'max_price_per_item',
            goalId: 'desk',
            strength: 'hard',
            value: { kind: 'money', amountPence, unit: 'item' },
            sourceQuote: quote,
          },
        ],
      });
    expect(() =>
      normalizeTaskPatch({ input: input('桌子50', 7000), task, text: '桌子50' }),
    ).toThrow('amount');
    expect(() =>
      normalizeTaskPatch({ input: input('可以加一点', 7000), task, text: '可以加一点' }),
    ).toThrow('amount');
    expect(
      normalizeTaskPatch({ input: input('可以加20', 7000), task, text: '可以加20' })?.constraints[0]
        ?.key,
    ).toBe('budget');
    expect(
      normalizeTaskPatch({ input: input('不增加预算', 5000), task, text: '不增加预算' })
        ?.constraints[0]?.value,
    ).toMatchObject({ amountPence: 5000 });
  });
});
