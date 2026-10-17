import { Bot } from 'grammy';
import { z } from 'zod';
import { createRepositories, createPrisma, type Repositories } from '@matchbot/db';
import {
  createTelegramSender,
  TelegramSendError,
  toInboundMessage,
} from '@matchbot/channel-telegram';
import { createLogger, type Env } from '@matchbot/shared';
import { configureModelProvider, createTraceProcessor, type AgentDeps } from '@matchbot/agent';
import { createJevClient, evaluateOutbound } from '@matchbot/jev';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { ActorLabConfig } from './actor-lab-config.js';
import { actorRoute, type ActorLabInbox } from './actor-lab-state.js';
import { drainOutbound } from './outbound-loop.js';

const meSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.literal(true),
  username: z.string(),
  can_read_all_group_messages: z.boolean().optional(),
});
const chatSchema = z.object({
  id: z.number().int(),
  type: z.enum(['group', 'supergroup']),
  title: z.string(),
});
export function openActorLab(env: Env, cfg: ActorLabConfig) {
  const logger = createLogger('actor-lab', env.LOG_LEVEL);
  const main = createPrisma(env.DATABASE_URL),
    control = createPrisma(cfg.controlDatabaseUrl);
  const mainRepos = createRepositories(main),
    repos = createRepositories(control);
  const target = new Bot(env.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } });
  const bots = cfg.actors.map((a) => new Bot(a.token, { client: { timeoutSeconds: 10 } }));
  const processor = createTraceProcessor({ traces: repos.traces, logger });
  configureModelProvider(env, [processor]);
  const deps: AgentDeps = {
    env,
    repos,
    logger,
    thresholds: DEFAULT_THRESHOLDS,
    evaluateOutbound,
    jev: createJevClient({
      baseUrl: env.JEV_BASE_URL,
      apiKey: env.JEV_API_KEY,
      model: env.JEV_MODEL,
      traces: repos.traces,
      logger,
      timeoutMs: 10000,
      maxRetries: 0,
    }),
  };
  const senders = new Map(
    cfg.actors.map((a, i) => [a.id, createTelegramSender({ bot: bots[i]!, logger })]),
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const bot of bots) if (bot.isRunning()) await bot.stop();
    await processor.forceFlush();
    await Promise.allSettled([main.$disconnect(), control.$disconnect()]);
  };
  async function verify() {
    const allow = env.TELEGRAM_ACTOR_ALLOWLIST.find((rule) => rule.chatId === cfg.groupId);
    if (
      !allow ||
      allow.botIds.length !== 3 ||
      !cfg.actors.every((a) => allow.botIds.includes(a.id))
    )
      throw new Error('actor_allowlist_not_configured');
    await target.init();
    const targetMe = meSchema.parse(target.botInfo);
    if (
      String(targetMe.id) !== cfg.matchBotId ||
      targetMe.username.toLowerCase() !== cfg.matchBotUsername.toLowerCase()
    )
      throw new Error('wrong_match_bot');
    if (!targetMe.can_read_all_group_messages)
      throw new Error('match_bot_requires_group_message_visibility');
    const chat = chatSchema.parse(await target.api.getChat(Number(cfg.groupId)));
    if (String(chat.id) !== cfg.groupId || chat.title !== cfg.groupTitle)
      throw new Error('wrong_test_group');
    for (const [i, bot] of bots.entries()) {
      await bot.init();
      const me = meSchema.parse(bot.botInfo),
        actor = cfg.actors[i]!;
      if (String(me.id) !== actor.id || me.username.toLowerCase() !== actor.username.toLowerCase())
        throw new Error('wrong_actor_identity');
      if (!me.can_read_all_group_messages)
        throw new Error('actor_requires_group_message_visibility');
      const member = z
        .object({ status: z.enum(['member', 'administrator', 'creator']) })
        .parse(await bot.api.getChatMember(Number(cfg.groupId), Number(actor.id)));
      if (!member.status) throw new Error('actor_not_in_test_group');
    }
  }
  async function activate() {
    await verify();
    await mainRepos.groups.upsert({
      channel: 'telegram',
      externalId: cfg.groupId,
      name: cfg.groupTitle,
    });
    return mainRepos.groups.setPolicy({
      channel: 'telegram',
      externalId: cfg.groupId,
      isActive: true,
      phase: 2,
      rateLimitPerDay: 30,
    });
  }
  async function assertActive() {
    const group = await mainRepos.groups.findByExternal('telegram', cfg.groupId);
    if (!group?.isActive || group.phase !== 2) throw new Error('test_group_not_active_phase2');
  }
  async function drain(runId: string, canSend: () => boolean = () => true) {
    await drainOutbound({
      repos,
      logger,
      defaultPhase: 2,
      sender: {
        send: async (row, options) => {
          let actor: string;
          try {
            actor = actorRoute(
              row,
              cfg.groupId,
              runId,
              cfg.actors.map((a) => a.id),
            );
          } catch {
            throw new TelegramSendError(row.id, null, {
              deliveryState: 'not_sent',
              errorCode: 'actor_route_rejected',
            });
          }
          const sender = senders.get(actor);
          if (!sender) throw new Error('actor_sender_missing');
          return sender.send(row, {
            beforeSend: async () => {
              if (!canSend()) return false;
              await assertActive();
              return options.beforeSend();
            },
          });
        },
      },
    });
  }
  function startInbox(
    inbox: ActorLabInbox,
    onReply: (actor: string, text: string) => void,
    onStop: () => void,
  ) {
    const polling = bots.map((bot) => {
      bot.on('message:text', (ctx) => {
        const m = ctx.message;
        if (String(m.chat.id) !== cfg.groupId) return;
        if (!m.from.is_bot && /^\/(?:stop|stoptest)|^停止测试$/.test(m.text.trim())) {
          onStop();
          return;
        }
        if (String(m.from.id) !== cfg.matchBotId) return;
        const message = toInboundMessage(ctx.update, {
          botId: bot.botInfo.id,
          actorAllowlist: [{ chatId: cfg.groupId, botIds: [cfg.matchBotId] }],
        });
        if (!message) return;
        const actor = inbox.accept(message);
        if (actor) onReply(actor, message.text.slice(0, 1800));
      });
      return bot.start({ timeout: 5, allowed_updates: ['message'] }).catch(() => {
        onStop();
        logger.error({ errorKind: 'actor_polling_failed' }, 'actor polling stopped');
      });
    });
    return polling;
  }
  return {
    cfg,
    logger,
    repos,
    mainRepos,
    deps,
    processor,
    verify,
    activate,
    assertActive,
    drain,
    startInbox,
    close,
  };
}
export type ActorLabRuntime = Awaited<ReturnType<typeof openActorLab>>;

export async function observeActorMessage(
  repos: Repositories,
  p: { groupId: string; actorId: string; externalMessageId: string },
) {
  const group = await repos.groups.findByExternal('telegram', p.groupId),
    user = await repos.users.findByExternal('telegram', p.actorId);
  if (!group || !user) return null;
  const message = await repos.messages.findExisting({
    groupId: group.id,
    userId: user.id,
    externalId: p.externalMessageId,
  });
  return message?.userId === user.id ? message : null;
}
