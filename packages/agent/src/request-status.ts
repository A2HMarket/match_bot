import { canAskTaskQuestion } from '@matchbot/domain';
import type { MatchContext } from './context.js';

/** Fixed public status, never a rewrite of the rejected recommendation. */
export function renderRequestStatus(ctx: MatchContext): string | null {
  if (
    !ctx.isRequestStatusRun ||
    !ctx.currentRequest?.isActionable ||
    ctx.answerRecorded ||
    ctx.replySuppressed ||
    ctx.currentRequest.demand.category === 'job'
  )
    return null;
  const unavailable =
    ctx.sourceFailures?.length &&
    !ctx.marketListings?.length &&
    !ctx.knowledgeSources?.length &&
    !ctx.xhsNotes?.length;
  const zh = ctx.currentRequest.demand.lang !== 'en';
  const intro = zh
    ? unavailable
      ? '刚才没查成，还没拿到结果。'
      : '我还没找到能放心推荐的，现有信息还不够。'
    : unavailable
      ? 'The search ran into a problem before I could get results.'
      : 'I don’t have enough reliable information to recommend an option yet.';
  const task =
    ctx.task?.ownerUserId === ctx.userId &&
    ctx.task.scope.chatId === ctx.chatId &&
    ctx.task.scope.channel === (ctx.channel ?? 'telegram')
      ? ctx.task
      : undefined;
  const next = task?.nextStep;
  if (!task || next?.action !== 'ask_user' || !next.constraintKey) return intro;
  // A failed search does not create a new user chore. Only an already-planned, unanswered personal constraint can be asked.
  const questions = {
    max_travel_minutes: {
      type: 'duration',
      zh: '单程最多能接受多久？',
      en: 'How long could a one-way trip be?',
    },
    area: { type: 'location', zh: '方便在哪一带？', en: 'Which area works for you?' },
    budget: { type: 'money', zh: '预算大概是多少？', en: 'What budget works for you?' },
    date: { type: 'date', zh: '你打算哪天用？', en: 'Which date do you need it for?' },
  } as const;
  const question = questions[next.constraintKey as keyof typeof questions];
  if (!question) return intro;
  const text = zh ? question.zh : question.en;
  return canAskTaskQuestion(task, {
    constraintKey: next.constraintKey,
    answerType: question.type,
    text,
    ...(next.goalId ? { goalId: next.goalId } : {}),
  })
    ? intro + '\n\n' + text
    : intro;
}
