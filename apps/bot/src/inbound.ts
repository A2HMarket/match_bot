import { toInboundMessage } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import { inboundRuleReason, resolvePhase } from '@matchbot/gating';
import { enqueueInbound as defaultEnqueue, type Queues } from '@matchbot/queue';
import type { TelegramActorAllowlist, Logger } from '@matchbot/shared';
import type { Update } from 'grammy/types';

/** Admit in polling order before Redis; unfinished accepted records are independently dispatchable. */
export function createInboundHandler(p: {
  botId: number;
  actorAllowlist?: TelegramActorAllowlist;
  botUsername?: string | undefined;
  repos: Repositories;
  queues: Queues;
  logger: Logger;
  defaultPhase?: Phase;
  enqueueInbound?: typeof defaultEnqueue;
}) {
  const enqueue = p.enqueueInbound ?? defaultEnqueue;
  return async (update: Update): Promise<void> => {
    const msg = toInboundMessage(update, {
      botId: p.botId,
      botUsername: p.botUsername,
      ...(p.actorAllowlist ? { actorAllowlist: p.actorAllowlist } : {}),
    });
    if (!msg) return;
    const isPrivate = update.message?.chat.type === 'private';
    const group = isPrivate ? null : await p.repos.groups.findByExternal('telegram', msg.chatId);
    if (!isPrivate && !group) {
      const chat = update.message?.chat,
        title = chat && 'title' in chat ? (chat.title ?? msg.chatId) : msg.chatId;
      const added = await p.repos.groups.upsert({
        channel: 'telegram',
        externalId: msg.chatId,
        name: title,
      });
      p.logger.info({ groupId: added.id }, 'new group requires activation');
      return;
    }
    const blocked = inboundRuleReason({
      text: msg.text,
      isPrivate,
      hasGroup: !!group,
      isGroupActive: group?.isActive ?? false,
    });
    if (blocked) {
      await p.repos.traces.create({
        kind: 'rule',
        inputRef: `${msg.channel}:${msg.chatId}:${msg.messageId}`,
        phase: resolvePhase({ group, defaultPhase: p.defaultPhase ?? 0 }),
        latencyMs: 0,
        costMicro: 0,
        output: { outcome: 'dropped_by_rule', reason: blocked },
      });
      return;
    }
    const user = await p.repos.users.upsertByExternal({
      channel: msg.channel,
      externalId: msg.userId,
      ...(msg.lang ? { lang: msg.lang } : {}),
    });
    const accepted = await p.repos.executions.accept({
      userId: user.id,
      groupId: group?.id ?? null,
      message: msg,
      phase: resolvePhase({ group, defaultPhase: p.defaultPhase ?? 0 }),
    });
    if (accepted.kind === 'legacy' || accepted.message.executionStatus !== 'accepted') return;
    try {
      await enqueue(p.queues, msg);
      await p.repos.executions.markEnqueued({ messageId: accepted.message.id, userId: user.id });
      p.logger.info({ inputRef: accepted.message.id }, 'accepted inbound enqueued');
    } catch (error) {
      p.logger.warn(
        {
          inputRef: accepted.message.id,
          errorKind: error instanceof Error ? error.name : 'unknown',
        },
        'accepted inbound awaits dispatch',
      );
    }
  };
}
