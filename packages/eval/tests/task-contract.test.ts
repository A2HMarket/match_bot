import { expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { gradeTaskTurn } from '../src/task-contract.js';
it('accepts a hard day condition that explicitly excludes Saturday, without accepting an unqualified weekend', () => {
  const task = taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '羽毛球',
    status: 'active',
    revision: 0,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
    constraints: [
      {
        key: 'day',
        strength: 'hard',
        value: { kind: 'text', text: '周日下午（周六不行）' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
    ],
  });
  const grade = () =>
    gradeTaskTurn(
      { excludedDay: 'saturday' },
      {
        task,
        before: [],
        after: [task],
        replyText: '',
        owner: 'owner',
        scope: 'group',
        searches: 0,
      },
    );
  expect(grade()).toEqual([]);
  task.constraints[0]!.value = { kind: 'text', text: '周日下午' };
  expect(grade()).toEqual([]);
  task.constraints[0]!.value = { kind: 'text', text: '周六、周日下午' };
  expect(grade()).toContain('excluded_day');
});
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

it('grades the effective monthly cap, including goal-scoped budgets and overriding caps', () => {
  const task = taskSchema.parse({
    id: 'housing',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '找一居室',
    category: 'housing',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'home',
        title: '一居室',
        required: true,
        criteria: [
          { id: 'subject', label: '一居室', strength: 'hard', status: 'unknown', evidenceRefs: [] },
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
    ],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const grade = () =>
    gradeTaskTurn(
      { monthlyBudgetPence: 160000 },
      {
        task,
        before: [],
        after: [task],
        replyText: '',
        owner: 'owner',
        scope: 'group',
        searches: 0,
      },
    );
  expect(grade()).toEqual([]);
  const cap = task.constraints[0]!;
  cap.value = { kind: 'money', amountPence: 160000, unit: 'item' };
  expect(grade()).toContain('monthly_budget');
  cap.value = { kind: 'money', amountPence: 170000, unit: 'month' };
  const { goalId: _goalId, ...shared } = cap;
  task.constraints.push({
    ...shared,
    value: { kind: 'money', amountPence: 160000, unit: 'month' },
  });
  expect(grade()).toContain('monthly_budget');
});

it('recognizes an explicit negative room-type condition, without accepting a positive or soft studio preference', () => {
  const task = taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '找房',
    status: 'active',
    revision: 0,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
    constraints: [
      {
        key: 'room_type',
        strength: 'hard',
        value: { kind: 'text', text: '一居室整租，不考虑studio' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
    ],
  });
  const grade = () =>
    gradeTaskTurn(
      { exclude: ['studio'] },
      {
        task,
        before: [],
        after: [task],
        replyText: '',
        owner: 'owner',
        scope: 'group',
        searches: 0,
      },
    );
  expect(grade()).toEqual([]);
  task.constraints[0]!.value = { kind: 'text', text: '可以考虑studio' };
  expect(grade()).toContain('exclude:studio');
  task.constraints[0]!.value = { kind: 'text', text: '不考虑studio' };
  task.constraints[0]!.strength = 'preference';
  expect(grade()).toContain('exclude:studio');
});

it('distinguishes a qualitative willingness to pay from an invented monetary cap', () => {
  const task = taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '羽毛球搭子',
    status: 'active',
    revision: 0,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
    constraints: [
      {
        key: 'budget',
        strength: 'preference',
        value: { kind: 'text', text: '可以收费' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
    ],
  });
  const grade = () =>
    gradeTaskTurn(
      { doNotInventBudget: true },
      {
        task,
        before: [],
        after: [task],
        replyText: '',
        owner: 'owner',
        scope: 'group',
        searches: 0,
      },
    );
  expect(grade()).toEqual([]);
  for (const value of [
    { kind: 'money' as const, amountPence: 2000, unit: 'person' as const },
    { kind: 'text' as const, text: '20镑以内' },
    { kind: 'text' as const, text: '免费' },
  ]) {
    task.constraints[0]!.value = value;
    expect(grade()).toContain('invented_budget');
  }
});
