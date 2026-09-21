import { inboundMessageSchema, type InboundMessage } from '@matchbot/domain';
import type { Update } from 'grammy/types';

/** 只接受文本消息；图片、贴纸、服务消息、Bot 自己的消息返回 null。渠道差异到此为止。 */
export function toInboundMessage(update: Update, p: { botId: number }): InboundMessage | null {
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
    receivedAt: new Date(m.date * 1000).toISOString(),
  });
}
