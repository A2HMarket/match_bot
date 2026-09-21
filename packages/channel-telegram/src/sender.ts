import type { OutboundMessage } from '@matchbot/db';
import type { Logger } from '@matchbot/shared';
import type { Bot } from 'grammy';

export class TelegramSendError extends Error {
  constructor(
    readonly outboundMessageId: string,
    cause: unknown,
  ) {
    super(
      `telegram send failed for ${outboundMessageId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'TelegramSendError';
  }
}

export function createTelegramSender(p: { bot: Bot; logger: Logger }) {
  return {
    async send(m: OutboundMessage): Promise<void> {
      try {
        await p.bot.api.sendMessage(Number(m.target), m.text, {
          link_preview_options: { is_disabled: true },
        });
        p.logger.info({ outboundMessageId: m.id, target: m.target }, 'sent');
      } catch (e) {
        throw new TelegramSendError(m.id, e);
      }
    },
  };
}
