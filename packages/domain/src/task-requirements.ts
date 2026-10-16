import { z } from 'zod';
import {
  assessTaskReadiness,
  taskConstraintSchema,
  taskCriterionSchema,
  taskGoalSchema,
  taskSchema,
  TaskTransitionError,
  type UserTask,
} from './task.js';

const sourceQuote = z.string().trim().min(1).max(600);
const goalDefinition = taskGoalSchema.omit({ criteria: true, userConfirmation: true }).extend({
  criteria: z
    .array(taskCriterionSchema.omit({ status: true, evidenceRefs: true }))
    .min(1)
    .max(24),
  sourceQuote,
});
const constraintChange = taskConstraintSchema.omit({ origin: true }).extend({ sourceQuote });
export const taskRequirementPatchSchema = z.strictObject({
  goals: z.array(goalDefinition).max(24),
  constraints: z.array(constraintChange).max(64),
});
export type TaskRequirementPatch = z.infer<typeof taskRequirementPatchSchema>;

function goalDefinitionOf(goal: UserTask['goals'][number]) {
  return {
    id: goal.id,
    title: goal.title,
    required: goal.required,
    criteria: goal.criteria.map(({ id, label, strength }) => ({ id, label, strength })),
  };
}
function constraintDefinitionOf(constraint: UserTask['constraints'][number]) {
  const { origin: _origin, ...definition } = constraint;
  return definition;
}

/** PRD §13: merge only named changes, retain the other subgoals, and recheck advice after changed requirements. */
export function reviseTaskRequirements(p: {
  task: UserTask;
  source: { messageId: string; text: string };
  patch: TaskRequirementPatch;
}): UserTask {
  const task = taskSchema.parse(p.task);
  if (['completed', 'cancelled', 'expired'].includes(task.status))
    throw new TaskTransitionError('terminal task cannot be reopened implicitly');
  assessTaskReadiness(task);
  const patch = taskRequirementPatchSchema.parse(p.patch);
  const source = z
    .strictObject({ messageId: taskSchema.shape.id, text: z.string().min(1) })
    .parse(p.source);
  for (const item of [...patch.goals, ...patch.constraints])
    if (!source.text.includes(item.sourceQuote))
      throw new TaskTransitionError('requirement change must quote the current user source');
  let changed = false;
  for (const { sourceQuote: _quote, ...definition } of patch.goals) {
    const index = task.goals.findIndex((goal) => goal.id === definition.id);
    const existing = task.goals[index];
    const criteria = existing ? goalDefinitionOf(existing).criteria : [];
    for (const criterion of definition.criteria) {
      const existingIndex = criteria.findIndex((c) => c.id === criterion.id);
      if (existingIndex < 0) criteria.push(criterion);
      else criteria[existingIndex] = criterion;
    }
    const merged = { ...definition, criteria };
    if (existing && JSON.stringify(goalDefinitionOf(existing)) === JSON.stringify(merged)) continue;
    if (existing?.userConfirmation)
      throw new TaskTransitionError('confirmed goal cannot be reopened implicitly');
    const next = taskGoalSchema.parse({
      ...merged,
      criteria: merged.criteria.map((criterion) => ({
        ...criterion,
        status: 'unknown',
        evidenceRefs: [],
      })),
    });
    if (index < 0) task.goals.push(next);
    else task.goals[index] = next;
    changed = true;
  }
  for (const { sourceQuote: _quote, ...definition } of patch.constraints) {
    const index = task.constraints.findIndex(
      (c) => c.key === definition.key && c.goalId === definition.goalId,
    );
    const existing = task.constraints[index];
    if (existing && JSON.stringify(constraintDefinitionOf(existing)) === JSON.stringify(definition))
      continue;
    const next = taskConstraintSchema.parse({
      ...definition,
      origin: { kind: 'user', sourceMessageId: source.messageId },
    });
    if (index < 0) task.constraints.push(next);
    else task.constraints[index] = next;
    changed = true;
  }
  if (changed) {
    task.requirementsVersion += 1;
    task.evidence = [];
    for (const goal of task.goals)
      for (const criterion of goal.criteria) {
        criterion.status = 'unknown';
        criterion.evidenceRefs = [];
      }
    task.status = 'active';
    task.delivery = { status: 'none', level: 'none' };
    task.blockReason = null;
  }
  if (
    task.pendingQuestion &&
    patch.constraints.some(
      (c) =>
        c.key === task.pendingQuestion!.constraintKey && c.goalId === task.pendingQuestion!.goalId,
    )
  ) {
    task.pendingQuestion = null;
    task.status = 'active';
  }
  task.revision += 1;
  assessTaskReadiness(task);
  return task;
}
