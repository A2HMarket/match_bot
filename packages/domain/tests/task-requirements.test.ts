import { describe, expect, it } from 'vitest';
import { assessTaskReadiness, taskSchema } from '../src/task.js';
import { reviseTaskRequirements, taskRequirementPatchSchema } from '../src/task-requirements.js';

function empty() {
  return taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'g' },
    objective: 'E14找桌椅，每件50',
    category: 'second_hand',
    status: 'active',
    revision: 0,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
function planned() {
  return reviseTaskRequirements({
    task: empty(),
    source: { messageId: 'm1', text: 'E14找桌椅，每件50' },
    patch: {
      goals: ['desk', 'chair'].map((id) => ({
        id,
        title: id,
        required: true,
        sourceQuote: '桌椅',
        criteria: [{ id: 'fit', label: '预算内可自提', strength: 'hard' as const }],
      })),
      constraints: ['desk', 'chair'].map((goalId) => ({
        goalId,
        key: 'budget',
        strength: 'hard' as const,
        value: { kind: 'money' as const, amountPence: 5000, unit: 'item' as const },
        sourceQuote: '每件50',
      })),
    },
  });
}
describe('requirement revisions', () => {
  it('does not let a planning proposal set source verdicts', () => {
    const goal = {
      id: 'desk',
      title: '书桌',
      required: true,
      sourceQuote: '书桌',
      criteria: [{ id: 'fit', label: '确为书桌', strength: 'hard' }],
    };
    expect(
      taskRequirementPatchSchema.safeParse({
        goals: [{ ...goal, sourceCoherence: 'supported' }],
        constraints: [],
      }).success,
    ).toBe(false);
    expect(
      taskRequirementPatchSchema.safeParse({
        goals: [
          { ...goal, criteria: [{ ...goal.criteria[0], conflictingEvidenceRefs: ['untrusted'] }] },
        ],
        constraints: [],
      }).success,
    ).toBe(false);
  });
  it('retains verification on identical requirements and does not clear another item question', () => {
    const t = planned();
    t.pendingQuestion = {
      id: 'chair-budget',
      goalId: 'chair',
      constraintKey: 'budget',
      text: '椅子预算？',
      answerType: 'money',
      deliveryStatus: 'sent',
      outboundMessageId: 'o',
    };
    const updated = reviseTaskRequirements({
      task: t,
      source: { messageId: 'm2', text: '桌子还是每件50' },
      patch: {
        goals: [
          {
            id: 'desk',
            title: 'desk',
            required: true,
            criteria: [{ id: 'fit', label: '预算内可自提', strength: 'hard' }],
            sourceQuote: '桌子',
          },
        ],
        constraints: [
          {
            key: 'budget',
            goalId: 'desk',
            strength: 'hard',
            value: { kind: 'money', amountPence: 5000, unit: 'item' },
            sourceQuote: '每件50',
          },
        ],
      },
    });
    expect(updated.requirementsVersion).toBe(t.requirementsVersion);
    expect(updated.constraints[0]?.origin).toEqual(t.constraints[0]?.origin);
    expect(updated.pendingQuestion).toEqual(t.pendingQuestion);
  });
  it('amends named goal criteria and clears only the answered question', () => {
    const t = planned();
    t.pendingQuestion = {
      id: 'radius',
      constraintKey: 'radius',
      text: '单程多久？',
      answerType: 'duration',
      deliveryStatus: 'sent',
      outboundMessageId: 'o',
    };
    const updated = reviseTaskRequirements({
      task: t,
      source: { messageId: 'm2', text: '桌子要实木，单程半小时以内' },
      patch: {
        goals: [
          {
            id: 'desk',
            title: '实木桌子',
            required: true,
            sourceQuote: '桌子要实木',
            criteria: [{ id: 'material', label: '实木', strength: 'hard' }],
          },
        ],
        constraints: [
          {
            key: 'radius',
            strength: 'hard',
            value: { kind: 'duration', minutes: 30 },
            sourceQuote: '单程半小时以内',
          },
        ],
      },
    });
    expect(updated.goals[0]?.criteria.map((c) => c.id)).toEqual(
      expect.arrayContaining(['fit', 'material']),
    );
    expect(updated.goals[1]?.criteria.map((c) => c.id)).toEqual(
      expect.arrayContaining(t.goals[1]!.criteria.map((c) => c.id)),
    );
    expect(updated.goals[1]?.criteria.some((c) => c.constraintKey === 'radius')).toBe(true);
    expect(updated.pendingQuestion).toBeNull();
    expect(updated.status).toBe('active');
  });
  it('does not silently replace completed subgoals with new requirements', () => {
    const t = planned();
    t.goals[1]!.userConfirmation = { userId: 'u', sourceMessageId: 'bought', intent: 'achieved' };
    expect(() =>
      reviseTaskRequirements({
        task: t,
        source: { messageId: 'm2', text: '另一把椅子' },
        patch: {
          goals: [
            {
              id: 'chair',
              title: '另一把椅子',
              required: true,
              sourceQuote: '另一把椅子',
              criteria: [{ id: 'fit', label: '符合需求', strength: 'hard' }],
            },
          ],
          constraints: [],
        },
      }),
    ).toThrow('confirmed goal');
  });
  it('preserves separate goals and untouched item budgets when the desk budget changes', () => {
    const t = planned();
    const updated = reviseTaskRequirements({
      task: t,
      source: { messageId: 'm2', text: '桌子可以到70，椅子仍50' },
      patch: {
        goals: [],
        constraints: [
          {
            key: 'budget',
            goalId: 'desk',
            strength: 'hard',
            value: { kind: 'money', amountPence: 7000, unit: 'item' },
            sourceQuote: '桌子可以到70',
          },
        ],
      },
    });
    expect(updated.goals.map((g) => g.id)).toEqual(['desk', 'chair']);
    expect(updated.constraints.map((c) => c.value)).toEqual([
      { kind: 'money', amountPence: 7000, unit: 'item' },
      { kind: 'money', amountPence: 5000, unit: 'item' },
    ]);
    expect(updated.constraints[0]?.origin).toEqual({ kind: 'user', sourceMessageId: 'm2' });
    expect(t.constraints[0]?.value).toMatchObject({ amountPence: 5000 });
    expect(updated.requirementsVersion).toBe(t.requirementsVersion + 1);
  });
  it('invalidates previous evidence and delivery when requirements change, preserving goals', () => {
    const t = planned();
    t.goals[0]!.sourceCoherence = 'supported';
    t.goals[0]!.criteria[0]!.status = 'supported';
    t.goals[0]!.criteria[0]!.evidenceRefs = ['e'];
    t.goals[0]!.criteria[0]!.conflictingEvidenceRefs = ['e'];
    t.evidence = [
      {
        id: 'e',
        goalId: 'desk',
        kind: 'source_excerpt',
        sourceRef: 'listing:old',
        summary: '旧条件下的候选',
        observedAt: '2026-10-17T00:00:00Z',
      },
    ];
    t.delivery = { status: 'sent', level: 'partial' };
    const updated = reviseTaskRequirements({
      task: t,
      source: { messageId: 'm2', text: '半小时以内' },
      patch: {
        goals: [],
        constraints: [
          {
            key: 'max_travel_minutes',
            strength: 'hard',
            value: { kind: 'duration', minutes: 30 },
            sourceQuote: '半小时以内',
          },
        ],
      },
    });
    expect(updated.goals[0]?.criteria[0]).toMatchObject({ status: 'unknown', evidenceRefs: [] });
    expect(updated.evidence).toEqual(t.evidence);
    expect(updated.goals[0]?.sourceCoherence).toBe('unknown');
    expect(updated.goals[0]?.criteria[0]?.conflictingEvidenceRefs).toEqual([]);
    expect(updated.delivery).toEqual({ status: 'none', level: 'none' });
    expect(assessTaskReadiness(updated).ready).toBe(false);
    expect(updated.objective).toBe(t.objective);
  });
  it('rejects invented provenance, unknown goal references and implicit reopening', () => {
    const p = {
      task: planned(),
      source: { messageId: 'm2', text: '半小时以内' },
      patch: {
        goals: [],
        constraints: [
          {
            key: 'budget',
            strength: 'hard' as const,
            value: { kind: 'money' as const, amountPence: 10000, unit: 'item' as const },
            sourceQuote: '预算100',
          },
        ],
      },
    };
    expect(() => reviseTaskRequirements(p)).toThrow('source');
    expect(() =>
      reviseTaskRequirements({
        ...p,
        patch: {
          goals: [],
          constraints: [
            { ...p.patch.constraints[0]!, sourceQuote: '半小时以内', goalId: 'missing' },
          ],
        },
      }),
    ).toThrow('existing goal');
    expect(() =>
      reviseTaskRequirements({ ...p, task: { ...p.task, status: 'completed' } }),
    ).toThrow('terminal');
  });
});
