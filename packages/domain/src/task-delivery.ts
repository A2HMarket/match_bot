import { z } from 'zod';
import {
  taskSchema,
  taskQuestionSchema,
  assessTaskReadiness,
  TaskTransitionError,
  type UserTask,
} from './task.js';

export const taskDeliveryQuestionSchema = taskQuestionSchema.omit({
  id: true,
  outboundMessageId: true,
  deliveryStatus: true,
});
export const taskDeliveryDraftSchema = z.strictObject({
  id: taskSchema.shape.id,
  requirementsVersion: taskSchema.shape.requirementsVersion,
  level: z.enum(['partial', 'ready']),
  question: taskDeliveryQuestionSchema.optional(),
});
const base = z.object({
  task: taskSchema,
  requirementsVersion: taskSchema.shape.requirementsVersion,
  outboundMessageId: taskSchema.shape.id,
});
const queuedSchema = base.extend({
  level: taskDeliveryDraftSchema.shape.level,
  question: taskDeliveryQuestionSchema.optional(),
});
const receiptSchema = base.extend({ status: z.enum(['sent', 'unknown', 'failed']) });
function requireCurrent(task: UserTask, version: number) {
  if (task.requirementsVersion !== version)
    throw new TaskTransitionError('stale task requirements');
  if (['completed', 'cancelled', 'expired'].includes(task.status))
    throw new TaskTransitionError('terminal task cannot change delivery');
}

/** A new owner turn supersedes the pending reply, even when it does not change a hard condition. */
export function beginTaskUserTurn(input: UserTask): UserTask {
  const task = taskSchema.parse(input);
  if (['completed', 'cancelled', 'expired'].includes(task.status)) return task;
  return {
    ...task,
    status: 'active',
    delivery: { status: 'none', level: 'none' },
    pendingQuestion: null,
    nextStep: null,
    blockReason: null,
    revision: task.revision + 1,
  };
}

/** A queued question is only a proposal; it cannot manufacture a user wait or outcome. */
export function queueTaskDelivery(raw: z.input<typeof queuedSchema>): UserTask {
  const p = queuedSchema.parse(raw),
    task = p.task,
    q = p.question;
  requireCurrent(task, p.requirementsVersion);
  if (q?.goalId && !task.goals.some((g) => g.id === q.goalId && !g.userConfirmation))
    throw new TaskTransitionError('question requires an unresolved known goal');
  if (
    q &&
    task.constraints.some((c) => c.key === q.constraintKey && (!c.goalId || c.goalId === q.goalId))
  )
    throw new TaskTransitionError('question condition is already known');
  task.delivery = {
    status: 'queued',
    level: p.level === 'ready' && !q && assessTaskReadiness(task).ready ? 'ready' : 'partial',
    outboundMessageId: p.outboundMessageId,
  };
  task.pendingQuestion = q
    ? {
        ...q,
        id: p.outboundMessageId,
        outboundMessageId: p.outboundMessageId,
        deliveryStatus: 'proposed',
      }
    : null;
  task.status = 'waiting_delivery';
  task.blockReason = null;
  task.revision++;
  return task;
}

/** Only a channel receipt can advance delivery; information delivered is not life-goal completed. */
export function recordTaskDeliveryReceipt(raw: z.input<typeof receiptSchema>): UserTask {
  const p = receiptSchema.parse(raw),
    task = p.task;
  requireCurrent(task, p.requirementsVersion);
  if (task.delivery.outboundMessageId !== p.outboundMessageId)
    throw new TaskTransitionError('receipt does not belong to current outbound');
  if (task.delivery.status === p.status) return task;
  if (task.delivery.status === 'sent' || task.delivery.status === 'failed')
    throw new TaskTransitionError('confirmed delivery state cannot be replaced');
  task.delivery.status = p.status;
  if (p.status === 'sent') {
    if (task.pendingQuestion) {
      task.pendingQuestion.deliveryStatus = 'sent';
      task.status = 'waiting_user';
      task.nextStep = {
        action: 'wait_user',
        owner: 'user',
        reason: '问题已送达，等待用户补充',
        constraintKey: task.pendingQuestion.constraintKey,
        ...(task.pendingQuestion.goalId ? { goalId: task.pendingQuestion.goalId } : {}),
      };
    } else {
      const ready = task.delivery.level === 'ready' && assessTaskReadiness(task).ready;
      task.delivery.level = ready ? 'ready' : 'partial';
      task.status = ready ? 'delivered' : 'active';
    }
    task.blockReason = null;
  } else {
    task.status = 'active';
    task.blockReason = p.status === 'unknown' ? 'delivery_unconfirmed' : 'delivery_failed';
    task.nextStep = {
      action: 'deliver',
      owner: 'agent',
      reason:
        p.status === 'unknown'
          ? '送达未确认，保留状态并停止自动重发'
          : '消息未送达，保留未完成任务',
    };
  }
  task.revision++;
  return task;
}
