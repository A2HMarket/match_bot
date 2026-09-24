import { inboundMessageSchema, type InboundMessage } from '@matchbot/domain';
import type { Update } from 'grammy/types';

/** 消息是否在对 bot 说话：回复 bot 的消息、@bot_username，或 text_mention 指向 bot。 */
function isAddressedToBot(
  m: NonNullable<Update['message']>,
  p: { botId: number; botUsername?: string | undefined },
): boolean {
  if (m.chat.type === 'private') return true; // 私聊里每一句都是对 bot 说的
  if (m.reply_to_message?.from?.id === p.botId) return true;
  const handle = p.botUsername ? `@${p.botUsername}`.toLowerCase() : null;
  return (m.entities ?? []).some((e) =>
    e.type === 'text_mention'
      ? e.user.id === p.botId
      : e.type === 'mention' &&
        handle !== null &&
        (m.text ?? '').slice(e.offset, e.offset + e.length).toLowerCase() === handle,
  );
}

/** 只接受文本消息；图片、贴纸、服务消息、Bot 自己的消息返回 null。渠道差异到此为止。 */
export function toInboundMessage(
  update: Update,
  p: { botId: number; botUsername?: string | undefined },
): InboundMessage | null {
  const m = update.message;
  if (!m || typeof m.text !== 'string' || !m.from || m.from.is_bot || m.from.id === p.botId)
    return null;
  if (m.chat.type !== 'private' && m.chat.type !== 'group' && m.chat.type !== 'supergroup')
    return null;
  const lang = m.from.language_code?.slice(0, 2);
  return inboundMessageSchema.parse({
    channel: 'telegram',
    chatId: String(m.chat.id),
    messageId: String(m.message_id),
    userId: String(m.from.id),
    text: m.text,
    ...(lang ? { lang } : {}),
    ...(m.reply_to_message ? { replyToMessageId: String(m.reply_to_message.message_id) } : {}),
    ...(isAddressedToBot(m, p) ? { addressedToBot: true } : {}),
    ...(m.reply_to_message?.from?.id === p.botId && m.reply_to_message.text
      ? { replyToBotText: m.reply_to_message.text.slice(0, 2000) }
      : {}),
    receivedAt: new Date(m.date * 1000).toISOString(),
  });
}
