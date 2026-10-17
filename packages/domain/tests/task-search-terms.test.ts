import { expect, it } from 'vitest';
import { taskSchema } from '../src/task.js';
import { rememberTaskSearchTerms } from '../src/task-search-terms.js';

function task() {
  return taskSchema.parse({
    id: 'task',
    ownerUserId: 'owner',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '收书桌',
    status: 'active',
    revision: 1,
    requirementsVersion: 1,
    goals: [
      {
        id: 'desk',
        title: '书桌候选',
        required: true,
        criteria: [
          { id: 'subject', label: '书桌', strength: 'hard', status: 'unknown', evidenceRefs: [] },
        ],
      },
    ],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
it('retains bounded search vocabulary without changing user constraints, evidence or completion', () => {
  const original = task(),
    hints = [{ goalId: 'desk', terms: ['书桌', 'desk', '书桌'] }];
  const saved = rememberTaskSearchTerms({ task: original, requirementsVersion: 1, hints });
  expect(saved.goals[0]?.searchTerms).toEqual(['书桌', 'desk']);
  expect(saved.requirementsVersion).toBe(1);
  expect(saved.revision).toBe(2);
  expect(saved.constraints).toEqual(original.constraints);
  expect(saved.evidence).toEqual(original.evidence);
  expect(saved.userConfirmation).toBeNull();
  expect(original.goals[0]?.searchTerms).toBeUndefined();
  const many = rememberTaskSearchTerms({
    task: saved,
    requirementsVersion: 1,
    hints: [{ goalId: 'desk', terms: Array.from({ length: 12 }, (_, i) => 'desk-' + i) }],
  });
  expect(many.goals[0]?.searchTerms).toHaveLength(12);
});
it('rejects stale, terminal, unknown and already solved goals', () => {
  const base = {
    task: task(),
    requirementsVersion: 1,
    hints: [{ goalId: 'desk', terms: ['desk'] }],
  };
  expect(() => rememberTaskSearchTerms({ ...base, requirementsVersion: 2 })).toThrow(
    'requirements',
  );
  expect(() =>
    rememberTaskSearchTerms({ ...base, task: { ...task(), status: 'completed' } }),
  ).toThrow('terminal');
  expect(() =>
    rememberTaskSearchTerms({ ...base, hints: [{ goalId: 'missing', terms: ['desk'] }] }),
  ).toThrow('goal');
  const solved = task();
  solved.goals[0]!.userConfirmation = {
    userId: 'owner',
    sourceMessageId: 'input',
    intent: 'achieved',
  };
  expect(() => rememberTaskSearchTerms({ ...base, task: solved })).toThrow('goal');
});
