import type { OutboundMessage } from '@matchbot/db';
import type { Logger } from '@matchbot/shared';
import type { Bot } from 'grammy';
import type { MessageEntity, ReactionTypeEmoji, User } from 'grammy/types';
import { formatRecommendation } from './recommendation-format.js';

type ReactionEmoji = ReactionTypeEmoji['emoji'];

export class TelegramSendError extends Error {
  constructor(
    readonly outboundMessageId: string,
    cause: unknown,
  ) {
    super(
      `telegram send failed for ${outboundMessageId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'TelegramSendError';
  }
}

/**
 * 在正文前加上对作者的 @。有 username 用 `@name`（Telegram 自动识别为提及）；
 * 没有就用 text_mention 实体，显示名字、点开是该用户。
 * 实体偏移按 UTF-16 计，与 JS 字符串 length 一致。
 */
export function withMention(
  text: string,
  user: Pick<User, 'id' | 'first_name' | 'username'>,
): { text: string; entities?: MessageEntity[] } {
  if (user.username) return { text: `@${user.username} ${text}` };
  const name = user.first_name.trim() || 'Hi';
  return {
    text: `${name} ${text}`,
    entities: [
      {
        type: 'text_mention',
        offset: 0,
        length: name.length,
        user: { id: user.id, is_bot: false, first_name: user.first_name },
      },
    ],
  };
}

export function createTelegramSender(p: { bot: Bot; logger: Logger }) {
  /** 名字发送时现查，不从库里取：outbound 表只存 user id（AGENTS.md §6）。 */
  async function lookupUser(chatId: number, userId: string) {
    try {
      return (await p.bot.api.getChatMember(chatId, Number(userId))).user;
    } catch (e) {
      p.logger.warn(
        { chatId, err: e instanceof Error ? e.message : String(e) },
        'mention lookup failed; sending as a plain reply',
      );
      return null;
    }
  }

  return {
    async send(m: OutboundMessage): Promise<void> {
      const chatId = Number(m.target);
      try {
        if (m.kind === 'reaction') {
          if (!m.replyToMessageId) throw new Error('reaction without a target message');
          await p.bot.api.setMessageReaction(chatId, Number(m.replyToMessageId), [
            { type: 'emoji', emoji: m.text as ReactionEmoji },
          ]);
          p.logger.info({ outboundMessageId: m.id, target: m.target }, 'reacted');
          return;
        }
        const user = m.mentionUserId ? await lookupUser(chatId, m.mentionUserId) : null;
        const formatted = formatRecommendation(m.text, m.kind);
        const body = user ? withMention(formatted.text, user) : { text: formatted.text };
        const mentionLength = body.text.length - formatted.text.length;
        const entities = [
          ...(body.entities ?? []),
          ...(formatted.entities ?? []).map((entity) => ({
            ...entity,
            offset: entity.offset + mentionLength,
          })),
        ];
        await p.bot.api.sendMessage(chatId, body.text, {
          link_preview_options: { is_disabled: true },
          ...(entities.length ? { entities } : {}),
          ...(m.replyToMessageId
            ? {
                // 原消息被删了也照发，只是不挂在它下面
                reply_parameters: {
                  message_id: Number(m.replyToMessageId),
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        });
        p.logger.info({ outboundMessageId: m.id, target: m.target }, 'sent');
      } catch (e) {
        throw new TelegramSendError(m.id, e);
      }
    },
  };
}
