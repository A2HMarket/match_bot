import { z } from 'zod';
import { taskSchema, TaskTransitionError, type UserTask } from './task.js';

export const taskSearchHintsSchema = z
  .array(
    z.strictObject({
      goalId: taskSchema.shape.id,
      terms: z.array(z.string().min(1).max(60)).min(1).max(12),
    }),
  )
  .min(1)
  .max(24);
/** Search vocabulary can survive a turn; it cannot promote an offer or change any requirement. */
export function rememberTaskSearchTerms(p: {
  task: UserTask;
  requirementsVersion: number;
  hints: z.input<typeof taskSearchHintsSchema>;
}): UserTask {
  const task = taskSchema.parse(p.task),
    hints = taskSearchHintsSchema.parse(p.hints);
  if (task.requirementsVersion !== p.requirementsVersion)
    throw new TaskTransitionError('stale task requirements');
  if (['completed', 'cancelled', 'expired'].includes(task.status))
    throw new TaskTransitionError('terminal task cannot record search terms');
  for (const hint of hints) {
    const goal = task.goals.find((g) => g.id === hint.goalId && !g.userConfirmation);
    if (!goal) throw new TaskTransitionError('search terms require an unresolved goal');
    goal.searchTerms = [...new Set([...hint.terms, ...(goal.searchTerms ?? [])])].slice(0, 12);
  }
  task.revision++;
  return task;
}
