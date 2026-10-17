import { taskSchema, type UserTask } from '@matchbot/domain';
import { z } from 'zod';

export const taskConversationSchema = z.object({
  id: z.string(),
  name: z.string(),
  turns: z.array(z.object({ input: z.string(), expect: z.record(z.string(), z.unknown()) })).min(1),
});
export const taskConversationsSchema = z.object({
  version: z.literal(1),
  frozenAt: z.string(),
  reviewedBaselineRevision: z.string(),
  cases: z.array(taskConversationSchema).min(12),
});
export type TaskObservation = {
  task: UserTask | null;
  before: UserTask[];
  after: UserTask[];
  updateKind?: string;
  replyText: string;
  replyAlias?: string;
  searches: number;
  owner: string;
  scope: string;
};
const flag = z.boolean().optional(),
  count = z.number().int().nonnegative().optional(),
  label = z.string().optional(),
  labels = z.array(z.string()).optional();
const expectations = z.strictObject({
  task: label,
  newTask: flag,
  requiredGoals: labels,
  budgetEachPence: count,
  area: label,
  replyTo: label,
  maxTravelMinutes: count,
  keep: labels,
  deskBudgetPence: count,
  chairBudgetPence: count,
  userConfirmedGoals: labels,
  taskCompleted: flag,
  monthlyBudgetPence: count,
  pets: z.literal('cat').optional(),
  roomType: z.literal('one_bedroom').optional(),
  moveInDate: label,
  petsHard: flag,
  billsPreference: flag,
  exclude: labels,
  counterparty: z.enum(['BUY', 'SELL', 'PEER']).optional(),
  level: z.literal('beginner').optional(),
  allowedDay: z.literal('sunday').optional(),
  excludedDay: z.literal('saturday').optional(),
  indoorHard: flag,
  doNotInventBudget: flag,
  housingBudgetUnchanged: flag,
  mustClarifyTask: flag,
  mustNotMutateEitherTask: flag,
  taskCancelled: flag,
  noFurtherSearch: flag,
  scope: label,
  mustNotRevealPrivateTask: flag,
  owner: label,
  mustRejectForeignTaskMutation: flag,
  capacityKg: count,
  departure: label,
  allowedItems: z.array(z.literal('clothes')).optional(),
  fixtureSource: label,
  mustExplainUnknowns: flag,
  mustNotRecommendKnownConflict: flag,
  mustAskSpecificRadiusIfNeeded: flag,
  mustNotInventRadius: flag,
  mustDistinguishUnavailable: flag,
  mustNotClaimAgentVerifiedAllCriteria: flag,
});
const subject = (goal: UserTask['goals'][number], name: string) =>
  name === 'desk'
    ? /书桌|办公桌|\bdesk\b/i.test(goal.title)
    : name === 'chair'
      ? /办公椅|\bchair\b/i.test(goal.title)
      : goal.id === name;
function budget(task: UserTask, goal?: string) {
  const id = goal ? task.goals.find((g) => subject(g, goal))?.id : undefined;
  const condition =
    task.constraints.find((c) => c.key === 'budget' && c.goalId === id) ??
    task.constraints.find((c) => c.key === 'budget' && !c.goalId);
  return condition?.value.kind === 'money' ? condition.value.amountPence : undefined;
}
const text = (task: UserTask, key: string) =>
  task.constraints
    .filter((c) => c.key === key)
    .map((c) => JSON.stringify(c.value))
    .join(' ');

/** Frozen user contracts grade authoritative observations; the runner never reads these expectations to generate actions. */
export function gradeTaskTurn(expected: Record<string, unknown>, raw: TaskObservation): string[] {
  const parsed = expectations.safeParse(expected);
  if (!parsed.success) return ['invalid_expectation'];
  expected = parsed.data;
  const task = raw.task ? taskSchema.parse(raw.task) : null,
    issues: string[] = [];
  const require = (ok: boolean, name: string) => {
    if (!ok) issues.push(name);
  };
  if (expected.newTask !== undefined)
    require(raw.after.length === raw.before.length + (expected.newTask ? 1 : 0) &&
      (!expected.newTask || !!task), 'new_task');
  if (expected.mustClarifyTask === true)
    require(['ambiguous', 'unbound'].includes(raw.updateKind ?? '') ||
      raw.replyText.includes('说明'), 'clarify_task');
  if (
    expected.mustNotMutateEitherTask === true ||
    expected.mustRejectForeignTaskMutation === true ||
    expected.mustNotRevealPrivateTask === true
  )
    require(JSON.stringify(raw.after) === JSON.stringify(raw.before), 'unrelated_task_mutated');
  if (expected.mustNotRevealPrivateTask === true)
    require(!raw.replyText.includes('private-housing') &&
      !raw.replyText.includes('1600'), 'private_task_disclosed');
  if (expected.noFurtherSearch === true) require(raw.searches === 0, 'searched_closed_task');
  if (typeof expected.owner === 'string') require(raw.owner === expected.owner, 'owner');
  if (typeof expected.scope === 'string') require(raw.scope === expected.scope, 'scope');
  if (typeof expected.replyTo === 'string')
    require(raw.replyAlias === expected.replyTo, 'reply_anchor');
  if (expected.mustExplainUnknowns === true)
    require(/未|没|缺|不确定|确认|unknown/i.test(raw.replyText), 'missing_explanation');
  if (expected.mustDistinguishUnavailable === true)
    require(/查询.*(?:没|未|失败)|没能完成|unavailable|could not/i.test(
      raw.replyText,
    ), 'unavailable_vs_empty');
  if (expected.mustNotRecommendKnownConflict === true)
    require(!raw.replyText.includes('/task-eval-conflict'), 'recommended_conflict');
  if (expected.mustAskSpecificRadiusIfNeeded === true)
    require(/单程|通勤|多久|范围/.test(raw.replyText), 'radius_question');
  if (!task) {
    if (expected.task && !expected.mustClarifyTask && !expected.mustRejectForeignTaskMutation)
      issues.push('missing_task');
    return issues;
  }
  if (Array.isArray(expected.requiredGoals))
    for (const goal of expected.requiredGoals)
      if (typeof goal === 'string')
        require(task.goals.some((g) => g.required && subject(g, goal)), 'missing_goal:' + goal);
  for (const [key, goal] of [
    ['deskBudgetPence', 'desk'],
    ['chairBudgetPence', 'chair'],
  ] as const)
    if (typeof expected[key] === 'number') require(budget(task, goal) === expected[key], key);
  if (typeof expected.budgetEachPence === 'number')
    require(['desk', 'chair'].every(
      (goal) => budget(task, goal) === expected.budgetEachPence,
    ), 'item_budget');
  if (typeof expected.monthlyBudgetPence === 'number')
    require(budget(task) === expected.monthlyBudgetPence, 'monthly_budget');
  if (typeof expected.maxTravelMinutes === 'number')
    require(task.constraints.some(
      (c) =>
        c.key === 'max_travel_minutes' &&
        c.value.kind === 'duration' &&
        c.value.minutes === expected.maxTravelMinutes,
    ), 'travel_minutes');
  if (typeof expected.area === 'string')
    require(task.constraints.some(
      (c) =>
        ['area', 'travel_origin'].includes(c.key) &&
        c.value.kind === 'location' &&
        c.value.area === expected.area,
    ), 'area');
  if (expected.pets === 'cat' || expected.petsHard === true)
    require(task.constraints.some(
      (c) =>
        c.key === 'pets' &&
        c.strength === 'hard' &&
        c.value.kind === 'text' &&
        /猫|cat/i.test(c.value.text) &&
        !/不允许|no cat/i.test(c.value.text),
    ), 'pets');
  if (expected.roomType === 'one_bedroom')
    require(task.goals.some((g) => /一居室|one.bedroom|1b1b/i.test(g.title)) ||
      /一居室|one.bedroom/.test(text(task, 'room_type')), 'room_type');
  if (typeof expected.moveInDate === 'string')
    require(task.constraints.some(
      (c) =>
        c.key === 'move_in_date' &&
        c.value.kind === 'date_range' &&
        c.value.from === expected.moveInDate &&
        c.value.to === expected.moveInDate,
    ), 'move_in_date');
  if (expected.billsPreference === true)
    require(task.constraints.some(
      (c) => c.key === 'bills' && c.strength === 'preference',
    ), 'bills_preference');
  if (expected.level === 'beginner')
    require(/初学|新手|beginner/i.test(text(task, 'level')), 'level');
  if (expected.counterparty)
    require(task.counterparty ===
      (expected.counterparty === 'BUY'
        ? 'demand'
        : expected.counterparty === 'PEER'
          ? 'peer'
          : 'supply'), 'counterparty');
  if (expected.allowedDay === 'sunday')
    require(/周日|星期日|Sunday/i.test(text(task, 'day')), 'allowed_day');
  if (expected.excludedDay === 'saturday')
    require(/周六|星期六|Saturday/i.test(text(task, 'exclude')), 'excluded_day');
  if (expected.indoorHard === true)
    require(task.constraints.some(
      (c) => c.strength === 'hard' && /室内|indoor/i.test(JSON.stringify(c.value)),
    ), 'indoor');
  if (expected.doNotInventBudget === true)
    require(!task.constraints.some((c) => c.key === 'budget'), 'invented_budget');
  if (expected.mustNotInventRadius === true)
    require(!task.constraints.some((c) => c.key === 'max_travel_minutes'), 'invented_radius');
  if (typeof expected.capacityKg === 'number')
    require(text(task, 'capacity').includes(String(expected.capacityKg)), 'capacity');
  if (typeof expected.departure === 'string')
    require(text(task, 'date').includes(expected.departure), 'departure');
  if (Array.isArray(expected.allowedItems))
    require(/衣服|clothes/i.test(text(task, 'feature')), 'allowed_items');
  if (Array.isArray(expected.exclude))
    for (const value of expected.exclude)
      if (typeof value === 'string')
        require(text(task, 'exclude').toLowerCase().includes(value.toLowerCase()), 'exclude:' +
          value);
  if (Array.isArray(expected.userConfirmedGoals))
    for (const value of expected.userConfirmedGoals)
      if (typeof value === 'string')
        require(task.goals.some(
          (g) => subject(g, value) && g.userConfirmation?.intent === 'achieved',
        ), 'confirmed_goal:' + value);
  if (expected.taskCompleted !== undefined)
    require((task.status === 'completed') === expected.taskCompleted, 'task_completion');
  if (expected.taskCancelled === true) require(task.status === 'cancelled', 'task_cancelled');
  if (expected.mustNotClaimAgentVerifiedAllCriteria === true)
    require(task.userConfirmation?.intent === 'achieved' &&
      task.goals.some((g) =>
        g.criteria.some((c) => c.status !== 'supported'),
      ), 'false_verified_completion');
  if (expected.housingBudgetUnchanged === true)
    require(raw.after
      .filter((t) => t.category === 'housing')
      .every((t) => budget(t) === 160000), 'housing_budget_changed');
  if (Array.isArray(expected.keep))
    for (const key of expected.keep) {
      if (typeof key !== 'string') {
        issues.push('invalid_keep');
        continue;
      }
      if (key === 'desk' || key === 'chair')
        require(task.goals.some((g) => subject(g, key)), 'lost:' + key);
      if (key === 'area')
        require(task.constraints.some((c) =>
          ['area', 'travel_origin'].includes(c.key),
        ), 'lost:area');
      if (key === 'level') require(!!text(task, 'level'), 'lost:level');
      if (key === 'capacityKg') require(!!text(task, 'capacity'), 'lost:capacity');
      if (key === 'departure') require(!!text(task, 'date'), 'lost:departure');
      if (key === 'counterparty')
        require(task.counterparty === 'peer' ||
          task.counterparty === 'demand', 'lost:counterparty');
      if (key === 'budgetEachPence')
        require(['desk', 'chair'].every((goal) => budget(task, goal) === 5000), 'lost:item_budget');
    }
  return issues;
}
