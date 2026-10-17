import { TaskTransitionError, type TaskActor, type UserTask } from '@matchbot/domain';

/** PRD §13: the model proposes an interpretation; only current owner text can ground a result. */
export function groundTaskConfirmation(p: {
  task: UserTask;
  userId: string;
  messageId: string;
  text: string;
  quote: string;
  intent: 'achieved' | 'cancelled';
  goalId?: string;
}): Extract<TaskActor, { kind: 'user' }> {
  if (p.userId !== p.task.ownerUserId)
    throw new TaskTransitionError('task outcome requires the owner');
  const quote = p.quote.trim();
  const sentence = p.text.split(/[。！!\n；;]/).find((s) => s.includes(quote)) ?? p.text;
  if (
    !quote ||
    !p.text.includes(quote) ||
    /如果|要是|的话|等到|打算|准备|希望|假如|\b(?:if|when|will|would|might|hope|plan to)\b/i.test(
      sentence,
    ) ||
    /[?？]|(?:买到|找好|约好|解决).{0,4}(?:吗|没|没有)(?:$|[，,。])/i.test(sentence)
  )
    throw new TaskTransitionError('explicit current user confirmation is required');
  if (p.goalId && !p.task.goals.some((g) => g.id === p.goalId))
    throw new TaskTransitionError('confirmation must identify a known goal');
  const achieved =
    /买到|买好|找到了|找好|租到|租好|解决|搞定|约好|安排好|定好|\b(?:bought|found|sorted|solved|arranged|booked|done)\b/i.test(
      quote,
    ) &&
    !/(?:没|未|没有|还没|尚未).{0,8}(?:买|找|租|解决|搞定|约|安排|定)|\b(?:not|never|haven.t|hasn.t)\b/i.test(
      quote,
    );
  const cancelled = /不(?:用再找|用找|找了|用了)|取消|先停|\b(?:cancel|stop|never mind)\b/i.test(
    quote,
  );
  if (!(p.intent === 'achieved' ? achieved : cancelled))
    throw new TaskTransitionError(
      'explicit current user confirmation is required: quote what was already solved with intent=achieved; use cancelled only for stopping an unsolved request',
    );
  const outstanding = p.task.goals.filter((g) => g.required && !g.userConfirmation);
  if (
    !p.goalId &&
    outstanding.length > 1 &&
    (/继续|还要|还想|仍在|\bstill\b/i.test(p.text) ||
      (p.intent === 'achieved' &&
        !/都|全|整个|这个需求|这件事|需求.{0,4}解决|\b(?:all|both|whole|everything)\b/i.test(
          quote,
        )))
  )
    throw new TaskTransitionError('whole-task confirmation must cover all remaining goals');
  return { kind: 'user', userId: p.userId, messageId: p.messageId, intent: p.intent };
}
