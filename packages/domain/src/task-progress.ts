import { z } from 'zod';
import {
  assessTaskReadiness,
  taskEvidenceSchema,
  taskNextStepSchema,
  taskSchema,
  TaskTransitionError,
  type UserTask,
} from './task.js';

export const taskProgressSchema = z.strictObject({
  requirementsVersion: z.number().int().nonnegative(),
  evidence: z.array(taskEvidenceSchema).max(128),
  checks: z
    .array(
      z.strictObject({
        goalId: taskSchema.shape.id,
        criterionId: taskSchema.shape.id,
        status: z.enum(['supported', 'unknown', 'conflict']),
        evidenceRefs: z.array(taskSchema.shape.id).max(16),
        conflictingEvidenceRefs: z.array(taskSchema.shape.id).max(16).optional(),
      }),
    )
    .max(64),
  nextStep: taskNextStepSchema,
  coherence: z
    .array(
      z.strictObject({
        goalId: taskSchema.shape.id,
        status: z.enum(['unknown', 'supported', 'conflict']),
      }),
    )
    .max(24)
    .default([]),
  hasSourceFailure: z.boolean().default(false),
});

/** PRD §13: source progress and responsible next step, never a user's real-world completion. */
export function recordTaskProgress(
  p: z.input<typeof taskProgressSchema> & { task: UserTask },
): UserTask {
  const task = taskSchema.parse(p.task);
  const { task: _task, ...raw } = p;
  const update = taskProgressSchema.parse(raw);
  if (task.requirementsVersion !== update.requirementsVersion)
    throw new TaskTransitionError('stale task requirements');
  if (['completed', 'cancelled', 'expired'].includes(task.status))
    throw new TaskTransitionError('terminal task cannot record progress');
  if (
    update.nextStep.goalId &&
    !task.goals.some((g) => g.id === update.nextStep.goalId && !g.userConfirmation)
  )
    throw new TaskTransitionError('next step requires an unresolved goal');
  if (update.nextStep.action === 'wait_user')
    throw new TaskTransitionError('only a delivery receipt may wait for a user');
  const owner = update.nextStep.action === 'wait_source' ? 'source' : 'agent';
  if (update.nextStep.owner !== owner)
    throw new TaskTransitionError('next step owner does not match its action');
  if (update.nextStep.action === 'wait_source' && !update.hasSourceFailure)
    throw new TaskTransitionError('source wait requires an observed source failure');
  const evidence = new Map(task.evidence.map((e) => [e.id, e]));
  for (const item of update.evidence) {
    const old = evidence.get(item.id);
    if (
      old &&
      (old.goalId !== item.goalId ||
        old.sourceRef !== item.sourceRef ||
        old.entityKey !== item.entityKey)
    )
      throw new TaskTransitionError('evidence identity cannot change its goal or source');
    evidence.set(item.id, item);
  }
  for (const check of update.checks) {
    const goal = task.goals.find((g) => g.id === check.goalId);
    const criterion = goal?.criteria.find((c) => c.id === check.criterionId);
    if (!criterion || goal?.userConfirmation)
      throw new TaskTransitionError('progress requires an unresolved known criterion');
    criterion.status = check.status;
    criterion.evidenceRefs = check.evidenceRefs;
    criterion.conflictingEvidenceRefs = check.conflictingEvidenceRefs ?? [];
  }
  task.evidence = [...evidence.values()];
  for (const goal of task.goals)
    if (goal.sourceCoherence !== undefined) goal.sourceCoherence = 'unknown';
  for (const checked of update.coherence) {
    const goal = task.goals.find((g) => g.id === checked.goalId);
    if (!goal || goal.userConfirmation)
      throw new TaskTransitionError('coherence requires an unresolved goal');
    goal.sourceCoherence = checked.status;
  }
  task.nextStep = update.nextStep;
  task.blockReason = update.nextStep.action === 'wait_source' ? update.nextStep.reason : null;
  task.status = update.nextStep.action === 'wait_source' ? 'waiting_source' : 'active';
  task.revision += 1;
  assessTaskReadiness(task);
  return task;
}
