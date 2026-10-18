/** Local private-chat transport. Real worker/model/database; no Telegram client or polling. */
import { createInterface } from 'node:readline/promises';
import { randomInt } from 'node:crypto';
import { loadEnv } from '../../packages/shared/src/index.js';
import { disconnectPrisma } from '../../packages/db/src/index.js';
import { buildDeps } from '../../apps/worker/src/deps.js';
import { processInbound } from '../../apps/worker/src/pipeline/inbound.js';
import { drainOutbound } from '../../apps/bot/src/outbound-loop.js';

const env = loadEnv({
  ...process.env,
  JEV_POLICY: process.env.JEV_POLICY ?? 'targeted',
  DEFAULT_PHASE: process.env.DEFAULT_PHASE ?? '2',
  REDIS_URL: 'redis://127.0.0.1:16379',
  TELEGRAM_BOT_TOKEN: 'local-transport-unused',
  TELEGRAM_OPS_CHAT_ID: '-999999999',
});
const destination = new URL(env.DATABASE_URL);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname) ||
  destination.pathname !== '/matchbot_local_test'
) {
  throw new Error('Use a dedicated loopback database named matchbot_local_test');
}
const deps = buildDeps({ env });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let userId = String(randomInt(100000000, 999999999));
let messageId = Date.now();
let replyToMessageId: string | undefined;
console.error(
  'Local chat: enter text; /user <numeric-id> switches private session; /quit exits. Receipts are simulated.',
);
try {
  for await (const text of rl) {
    if (text === '/quit') break;
    if (/^\/user \d+$/.test(text)) {
      userId = text.slice(6);
      replyToMessageId = undefined;
      console.error('Session: ' + userId);
      continue;
    }
    if (!text.trim()) continue;
    const result = await processInbound(deps, {
      channel: 'telegram',
      chatId: userId,
      userId,
      messageId: String(++messageId),
      text,
      receivedAt: new Date().toISOString(),
      addressedToBot: true,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    if (result?.deferMs)
      console.error('Session busy; input deferred. Retry after ' + result.deferMs + ' ms.');
    let delivered = false;
    await drainOutbound({
      repos: deps.repos,
      logger: deps.logger,
      defaultPhase: env.DEFAULT_PHASE === 1 || env.DEFAULT_PHASE === 2 ? env.DEFAULT_PHASE : 0,
      opsChatId: env.TELEGRAM_OPS_CHAT_ID,
      sender: {
        send: async (message, options) => {
          if (!(await options.beforeSend())) return { kind: 'not_started' };
          const externalMessageId = String(++messageId);
          console.log(
            JSON.stringify({ target: message.target, text: message.text, externalMessageId }),
          );
          if (message.target === userId) replyToMessageId = externalMessageId;
          delivered = true;
          return message.kind === 'reaction'
            ? { kind: 'reaction', externalMessageId: null }
            : { kind: 'message', externalMessageId };
        },
      },
    });
    if (!delivered)
      console.error(
        'No delivered reply. Inspect traces: phase 0, approval, or a gate may have stopped delivery.',
      );
  }
} finally {
  rl.close();
  await disconnectPrisma();
}
