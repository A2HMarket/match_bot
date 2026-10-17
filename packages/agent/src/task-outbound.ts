import {
  assessTaskReadiness,
  canAskTaskQuestion,
  TaskTransitionError,
  type OutboundDraft,
  type UserTask,
} from '@matchbot/domain';
import type { MatchContext } from './context.js';
import type { OutboundDraftInput } from './tools/outbound-gate.js';
import { renderRequestStatus } from './request-status.js';

function answerType(
  key: string,
  text: string,
): NonNullable<UserTask['pendingQuestion']>['answerType'] {
  if (key === 'max_travel_minutes') return 'duration';
  if (key === 'budget') return 'money';
  if (key === 'date' || key === 'move_in_date') return 'date';
  if (['area', 'travel_origin', 'route_from', 'route_to'].includes(key)) return 'location';
  if (
    key === 'self_collect' ||
    /是否|能否|可不可以|(?:可以|需要|能).{0,12}吗[？?]?$|^(?:can|do|does|is|are|would)\b/i.test(
      text,
    )
  )
    return 'boolean';
  return 'text';
}
/** Server metadata only. User-visible text still goes through its original tool and gate. */
export function taskDeliveryForOutbound(
  ctx: MatchContext,
  draft: OutboundDraftInput,
): OutboundDraft['taskDelivery'] {
  const task = ctx.task;
  if (
    !task ||
    !ctx.execution ||
    task.ownerUserId !== ctx.userId ||
    task.scope.chatId !== ctx.chatId ||
    task.scope.channel !== (ctx.channel ?? 'telegram') ||
    draft.target !== ctx.chatId ||
    draft.kind === 'reaction' ||
    draft.kind === 'lead'
  )
    return undefined;
  const next = task.nextStep,
    text = draft.taskQuestionText ?? draft.text;
  if (
    draft.replyPurpose !== 'request_status' &&
    (draft.kind === 'clarification' || /[?？]/.test(text)) &&
    (next?.action !== 'ask_user' || !next.constraintKey)
  )
    throw new TaskTransitionError(
      'Record the one missing condition with record_task_progress next action=ask_user and its constraintKey before asking the user.',
    );
  let key: string | undefined, goalId: string | undefined;
  if (
    next?.action === 'ask_user' &&
    next.constraintKey &&
    (draft.kind === 'clarification' || /[?？]/.test(text))
  ) {
    key = next.constraintKey;
    goalId = next.goalId;
  }
  if (
    draft.replyPurpose === 'request_status' &&
    draft.text === renderRequestStatus(ctx) &&
    /[?？]/.test(text)
  ) {
    key = /多久.*单程|单程.*多久/.test(text) ? 'max_travel_minutes' : 'custom:next_information';
    goalId = undefined;
  }
  if (
    key &&
    !canAskTaskQuestion(task, {
      constraintKey: key,
      answerType: answerType(key, text),
      text,
      ...(goalId ? { goalId } : {}),
    })
  )
    throw new TaskTransitionError(
      'This question is already answered in the task; use the known condition rather than asking it again.',
    );
  if (key && text.length > 500)
    throw new TaskTransitionError('Ask one short task question within 500 characters.');
  if (key && !draft.text.includes(text))
    throw new TaskTransitionError(
      'The question must appear in the actual outbound text. Keep the advice and question short enough that the rendered message preserves them.',
    );
  const question = key
    ? { constraintKey: key, answerType: answerType(key, text), text, ...(goalId ? { goalId } : {}) }
    : undefined;
  return {
    id: task.id,
    requirementsVersion: task.requirementsVersion,
    level:
      draft.kind === 'recommendation' &&
      draft.replyPurpose !== 'request_status' &&
      ctx.taskProgressVersion === task.requirementsVersion &&
      next?.action === 'deliver' &&
      assessTaskReadiness(task).ready &&
      !question
        ? 'ready'
        : 'partial',
    ...(question ? { question } : {}),
  };
}
