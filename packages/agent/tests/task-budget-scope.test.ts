import { expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { normalizeTaskPatch } from '../src/task-proposal.js';
import { taskCurrentRequest } from '../src/task-request.js';

function task() {
  return taskSchema.parse({
    id: 'task',
    ownerUserId: 'owner',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '租一居室',
    category: 'housing',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'home',
        title: '一居室',
        required: true,
        criteria: [
          { id: 'subject', label: '房源', strength: 'hard', status: 'unknown', evidenceRefs: [] },
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
function patch(quote: string) {
  return {
    goals: [],
    constraints: [
      {
        key: 'budget',
        goalId: null,
        strength: 'hard' as const,
        value: { kind: 'money' as const, amountPence: 160000, unit: 'month' as const },
        sourceQuote: quote,
      },
    ],
  };
}
it('retains an explicit rent-only budget across a short followup and exposes its scope to the answer and judge', () => {
  const t = task(),
    result = normalizeTaskPatch({
      task: t,
      input: patch('月租1600镑以内'),
      text: '一居室，月租1600镑以内，我有猫',
    });
  expect(result?.constraints[0]?.budgetScope).toBe('rent_only');
  t.constraints = result!.constraints.map(({ sourceQuote: _quote, ...c }) => ({
    ...c,
    origin: { kind: 'user', sourceMessageId: 'first' },
  }));
  const followup = normalizeTaskPatch({
    task: t,
    input: patch('预算不能增加'),
    text: '预算不能增加，包账单更好',
  });
  expect(followup?.constraints[0]?.budgetScope).toBe('rent_only');
  const request = taskCurrentRequest(
    {
      userId: 'owner',
      chatId: '-1',
      groupId: null,
      phase: 0,
      sourceMessageId: 'second',
      recentReplies: [],
      task: t,
    },
    '预算不能增加，包账单更好',
  );
  expect(request?.demand.budgetScope).toBe('rent_only');
  expect(request?.text).toContain('rent only');
});
it('distinguishes explicit all-in limits from optional bills preferences and leaves ambiguous scope unspecified', () => {
  expect(
    normalizeTaskPatch({
      task: task(),
      input: patch('总预算1600镑包含账单'),
      text: '总预算1600镑包含账单',
    })?.constraints[0]?.budgetScope,
  ).toBe('all_in');
  expect(
    normalizeTaskPatch({ task: task(), input: patch('月租1600'), text: '月租1600，包账单更好' })
      ?.constraints[0]?.budgetScope,
  ).toBe('rent_only');
  expect(
    normalizeTaskPatch({ task: task(), input: patch('预算1600'), text: '预算1600' })?.constraints[0]
      ?.budgetScope,
  ).toBeUndefined();
});
