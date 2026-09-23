import type { MatchContext } from '../context.js';

/**
 * 群内回帖的寻址：回复触发消息，并 @ 它的作者——群里消息多，不 @ 的追问
 * 很容易被当成对别人说的。私聊不需要 @。旧快照没有 source 时退化为普通发帖。
 */
export function groupReplyAddressing(ctx: MatchContext): {
  replyToMessageId?: string;
  mentionUserId?: string;
} {
  if (!ctx.source) return {};
  return ctx.groupId
    ? { replyToMessageId: ctx.source.messageId, mentionUserId: ctx.source.userId }
    : { replyToMessageId: ctx.source.messageId };
}
