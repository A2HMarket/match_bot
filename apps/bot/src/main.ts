import { createTelegramSender } from '@matchbot/channel-telegram';
import { createRepositories, disconnectPrisma, getPrisma } from '@matchbot/db';
import { closeQueues, createQueues } from '@matchbot/queue';
import { createLogger, loadEnv } from '@matchbot/shared';
import { Bot } from 'grammy';
import { createInboundHandler } from './inbound.js';
import { startOutboundLoop } from './outbound-loop.js';

const env = loadEnv();
const log = createLogger('bot', env.LOG_LEVEL);
const repos = createRepositories(getPrisma(env.DATABASE_URL));
const queues = createQueues(env.REDIS_URL);
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
const me = await bot.api.getMe();

const inbound = createInboundHandler({ botId: me.id, repos, queues, logger: log });
bot.on('message:text', (ctx) => inbound(ctx.update));
// TODO(P9): approval 包完成后在此 registerApprovalCallbacks({ bot, repos, queues, opsChatId: env.TELEGRAM_OPS_CHAT_ID })
const stopLoop = startOutboundLoop({
  repos,
  sender: createTelegramSender({ bot, logger: log }),
  logger: log,
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopLoop();
    void bot.stop();
    void closeQueues(queues);
    void disconnectPrisma();
  });
}
log.info({ botId: me.id, phase: env.DEFAULT_PHASE }, 'bot started');
await bot.start();
