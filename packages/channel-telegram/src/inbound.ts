import type { TelegramActorAllowlist } from '@matchbot/shared';
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
  const text = m.text ?? m.caption ?? '';
  const entities = typeof m.text === 'string' ? m.entities : m.caption_entities;
  return (entities ?? []).some((e) =>
    e.type === 'text_mention'
      ? e.user.id === p.botId
      : e.type === 'mention' &&
        handle !== null &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() === handle,
  );
}

/** 接受文本及媒体说明文字；无文字的媒体、服务消息、Bot 自己的消息返回 null。渠道差异到此为止。 */
export function toInboundMessage(
  update: Update,
  p: { botId: number; botUsername?: string | undefined; actorAllowlist?: TelegramActorAllowlist },
): InboundMessage | null {
  const m = update.message;
  const text = m?.text ?? m?.caption;
  if (!m || typeof text !== 'string' || !m.from || m.from.id === p.botId) return null;
  if (
    m.from.is_bot &&
    (m.chat.type === 'private' ||
      !p.actorAllowlist?.some(
        (rule) => rule.chatId === String(m.chat.id) && rule.botIds.includes(String(m.from.id)),
      ))
  )
    return null;
  if (m.chat.type !== 'private' && m.chat.type !== 'group' && m.chat.type !== 'supergroup')
    return null;
  const lang = m.from.language_code?.slice(0, 2);
  return inboundMessageSchema.parse({
    channel: 'telegram',
    chatId: String(m.chat.id),
    messageId: String(m.message_id),
    userId: String(m.from.id),
    text,
    ...(lang ? { lang } : {}),
    ...(m.reply_to_message ? { replyToMessageId: String(m.reply_to_message.message_id) } : {}),
    ...(isAddressedToBot(m, p) ? { addressedToBot: true } : {}),
    ...(m.reply_to_message?.from?.id === p.botId && m.reply_to_message.text
      ? { replyToBotText: m.reply_to_message.text.slice(0, 2000) }
      : {}),
    receivedAt: new Date(m.date * 1000).toISOString(),
  });
}
