import {
  configureModelProvider,
  createTraceProcessor,
  resumeRun,
  runInbound,
} from '@matchbot/agent';
import { publishApproval } from '@matchbot/approval';
import { createRepositories, getPrisma } from '@matchbot/db';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createJevClient, evaluateInbound, evaluateOutbound } from '@matchbot/jev';
import { createOpsCardSenderFromToken } from '@matchbot/channel-telegram';
import { createLogger, loadEnv, type Env, type Logger } from '@matchbot/shared';
import { createWebSearch } from '@matchbot/websearch';
import type { PipelineDeps } from './pipeline/inbound.js';
import type { ResumeDeps } from './pipeline/resume.js';

export type WorkerDeps = PipelineDeps & ResumeDeps;

/** publishApproval 需要的最小端口；实现由调用方注入（见下方 createOpsCardSender 的说明）。 */
export type ApprovalCards = PipelineDeps['cards'];

/**
 * 显式失败的占位：只在没有 `TELEGRAM_BOT_TOKEN` 时用（测试注入自己的 cards）。
 * Phase 1 一旦用到就 error 级留痕，而不是静默丢卡。
 */
export function createUnwiredCards(logger: Logger): ApprovalCards {
  return {
    sendApprovalCard(card) {
      logger.error(
        { runStateId: card.runStateId },
        'approval card NOT sent: no ops card sender configured',
      );
      return Promise.resolve({ messageId: '' });
    },
  };
}

/**
 * 进程级装配。`configureModelProvider` 与 `setTraceProcessors` 都是全局副作用，只在这里调一次
 * （PoC V6 ①：setTraceProcessors 是整体替换，调用后默认 OpenAI exporter 不再生效 = §3.3 第 9 条）。
 */
export function buildDeps(p: { env?: Env; cards?: ApprovalCards } = {}): WorkerDeps {
  const env = p.env ?? loadEnv();
  const logger = createLogger('worker', env.LOG_LEVEL);
  const repos = createRepositories(getPrisma(env.DATABASE_URL));
  configureModelProvider(env, [createTraceProcessor({ traces: repos.traces, logger })]);
  const jev = createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    traces: repos.traces,
    logger,
  });
  // worker 自己不碰 grammy：只从 channel-telegram 取「发审批卡」这一个能力（AGENTS.md §3.2）。
  // 该 Bot 只发不收、不 start()，所以不会和 apps/bot 的长轮询抢 getUpdates。
  const cards =
    p.cards ??
    createOpsCardSenderFromToken({
      token: env.TELEGRAM_BOT_TOKEN,
      opsChatId: env.TELEGRAM_OPS_CHAT_ID,
    });
  return {
    env,
    repos,
    jev,
    thresholds: DEFAULT_THRESHOLDS,
    logger,
    evaluateOutbound,
    evaluateInbound,
    runInbound,
    resumeRun,
    publishApproval,
    cards,
    ...(env.SEARCH_API_KEY
      ? { webSearch: createWebSearch({ apiKey: env.SEARCH_API_KEY, logger }) }
      : {}),
  };
}
