import { describe, expect, it } from 'vitest';
import { assessTaskReadiness, taskSchema } from '../src/task.js';
import { reviseTaskRequirements } from '../src/task-requirements.js';

function task() {
  return taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '买桌椅',
    status: 'active',
    revision: 0,
    goals: ['desk', 'chair'].map((id) => ({
      id,
      title: id,
      required: true,
      criteria: [
        {
          id: 'source',
          label: '有可行动的来源',
          strength: 'hard',
          status: 'unknown',
          evidenceRefs: [],
        },
      ],
    })),
    constraints: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
describe('criteria bound to current requirements', () => {
  it('adds per-goal and shared acceptance checks without embedding stale money into labels', () => {
    const t = reviseTaskRequirements({
      task: task(),
      source: { messageId: 'm', text: '桌子70，半小时内自提' },
      patch: {
        goals: [],
        constraints: [
          {
            key: 'budget',
            goalId: 'desk',
            strength: 'hard',
            value: { kind: 'money', amountPence: 7000, unit: 'item' },
            sourceQuote: '桌子70',
          },
          {
            key: 'max_travel_minutes',
            strength: 'hard',
            value: { kind: 'duration', minutes: 30 },
            sourceQuote: '半小时内',
          },
        ],
      },
    });
    expect(
      t.goals[0]?.criteria
        .filter((c) => c.constraintKey)
        .map((c) => c.constraintKey)
        .sort(),
    ).toEqual(['budget', 'max_travel_minutes']);
    expect(t.goals[1]?.criteria.filter((c) => c.constraintKey).map((c) => c.constraintKey)).toEqual(
      ['max_travel_minutes'],
    );
    expect(t.goals[0]?.criteria.some((c) => c.label.includes('70'))).toBe(false);
  });
  it('keeps condition strength authoritative and does not duplicate an already bound criterion', () => {
    const initial = task();
    initial.goals[0]!.criteria.push({
      id: 'budget-fit',
      label: '旧预算50',
      constraintKey: 'budget',
      strength: 'preference',
      status: 'unknown',
      evidenceRefs: [],
    });
    initial.constraints = [
      {
        key: 'budget',
        goalId: 'desk',
        strength: 'hard',
        value: { kind: 'money', amountPence: 5000, unit: 'item' },
        origin: { kind: 'user', sourceMessageId: 'old' },
      },
    ];
    const t = reviseTaskRequirements({
      task: initial,
      source: { messageId: 'm', text: '桌子70' },
      patch: {
        goals: [],
        constraints: [
          {
            key: 'budget',
            goalId: 'desk',
            strength: 'hard',
            value: { kind: 'money', amountPence: 7000, unit: 'item' },
            sourceQuote: '桌子70',
          },
        ],
      },
    });
    const bound = t.goals[0]!.criteria.filter((c) => c.constraintKey === 'budget');
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ strength: 'hard', status: 'unknown' });
    expect(bound[0]?.label).not.toContain('50');
  });
  it('does not add new checks to a resolved goal and rejects cross-goal condition bindings', () => {
    const initial = task();
    initial.goals[1]!.userConfirmation = {
      userId: 'u',
      sourceMessageId: 'bought',
      intent: 'achieved',
    };
    const t = reviseTaskRequirements({
      task: initial,
      source: { messageId: 'm', text: '半小时内' },
      patch: {
        goals: [],
        constraints: [
          {
            key: 'max_travel_minutes',
            strength: 'hard',
            value: { kind: 'duration', minutes: 30 },
            sourceQuote: '半小时内',
          },
        ],
      },
    });
    expect(t.goals[1]?.criteria).toEqual(initial.goals[1]?.criteria);
    const invalid = task();
    invalid.goals[1]!.criteria[0]!.constraintKey = 'budget';
    invalid.constraints = [
      {
        key: 'budget',
        goalId: 'desk',
        strength: 'hard',
        value: { kind: 'money', amountPence: 5000, unit: 'item' },
        origin: { kind: 'user', sourceMessageId: 'old' },
      },
    ];
    expect(() => assessTaskReadiness(invalid)).toThrow('condition binding');
  });
});
