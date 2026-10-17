import type { MatchContext } from './context.js';
import { isActionableRequestText } from './current-request.js';

/** Quiet is limited to context additions, never a new question or an explicit danger signal. */
export function isContextSupplement(text: string): boolean {
  return (
    text.trim().length <= 60 &&
    !isActionableRequestText(text) &&
    !/突然|剧烈|严重|昏|呼吸|视力|说话困难|无力|出血|麻木|抽搐|意识|看不见|救命|急救|sudden|severe|faint|emergency|breath|vision|weak|numb|seizure|confus|head injury/i.test(
      text,
    )
  );
}
export function canSkipSupplementReply(ctx: MatchContext): boolean {
  const task = ctx.task;
  return (
    !!task &&
    ctx.quietSupplementTaskId === task.id &&
    ctx.taskUpdate?.kind === 'continued' &&
    task.ownerUserId === ctx.userId &&
    task.scope.chatId === ctx.chatId &&
    task.scope.channel === (ctx.channel ?? 'telegram') &&
    !['completed', 'cancelled', 'expired'].includes(task.status)
  );
}
