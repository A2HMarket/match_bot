import { expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { gradeTaskTurn } from '../src/task-contract.js';
it('rejects dropped goals and invented budgets, rather than counting any reply as success', () => {
  const task = taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '买桌椅',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'desk',
        title: '书桌',
        required: true,
        criteria: [
          { id: 'source', label: '书桌', strength: 'hard', status: 'unknown', evidenceRefs: [] },
        ],
      },
    ],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const result = gradeTaskTurn(
    { requiredGoals: ['desk', 'chair'], budgetEachPence: 5000 },
    {
      task,
      before: [],
      after: [task],
      replyText: '已经回复',
      owner: 'owner',
      scope: 'group',
      searches: 0,
    },
  );
  expect(result).toContain('missing_goal:chair');
  expect(result).toContain('item_budget');
});
