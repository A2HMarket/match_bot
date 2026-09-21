import { toInboundMessage } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import { enqueueInbound as defaultEnqueue, type Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';
import type { Update } from 'grammy/types';

/** Update -> InboundMessage -> 入队。群未登记时先登记为 inactive 等运营开启（PRD §6.2），私聊直接入队。 */
export function createInboundHandler(p: {
  botId: number;
  repos: Repositories;
  queues: Queues;
  logger: Logger;
  enqueueInbound?: typeof defaultEnqueue;
}) {
  const enqueue = p.enqueueInbound ?? defaultEnqueue;
  return async (update: Update): Promise<void> => {
    const msg = toInboundMessage(update, { botId: p.botId });
    if (!msg) return;
    const isPrivate = update.message?.chat.type === 'private';
    if (!isPrivate) {
      const group = await p.repos.groups.findByExternal('telegram', msg.chatId);
      if (!group) {
        const chat = update.message?.chat;
        const title = chat && 'title' in chat ? (chat.title ?? msg.chatId) : msg.chatId;
        await p.repos.groups.upsert({ channel: 'telegram', externalId: msg.chatId, name: title });
        p.logger.info({ chatId: msg.chatId }, 'new group seen; inactive until ops enables');
        return;
      }
      if (!group.isActive) return;
    }
    await enqueue(p.queues, msg);
  };
}
