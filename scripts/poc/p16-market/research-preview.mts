/** 真实A2H/DeepSeek预览：内存仓储、Phase 0，不写生产数据、不发送 Telegram。 */
import { writeFileSync } from 'node:fs';
import {
  configureModelProvider,
  createTraceProcessor,
  runInbound,
} from '../../../packages/agent/src/index.js';
import type { MatchContext } from '../../../packages/agent/src/context.js';
import type { Repositories } from '../../../packages/db/src/index.js';
import { outboundDraftSchema } from '../../../packages/domain/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { createMarketSearch } from '../../../packages/websearch/dist/index.js';
const env = loadEnv(),
  logger = createLogger('market-preview');
const input = process.argv[2] ?? '伦敦想收一个二手小绿锅，看看有哪些出售的，介绍一下成色和自提位置';
const category =
  input.includes('租房') || input.includes('房源')
    ? 'housing'
    : input.includes('帮带') || input.includes('搭子')
      ? 'other'
      : 'second_hand';
const traceRows: unknown[] = [],
  drafts: Array<{ text: string }> = [],
  session: unknown[] = [];
const requests: Array<{
  path: string;
  keyword: string | null;
  tradeType: string | null;
  status: number;
}> = [];
const repos = {
  traces: {
    create: (raw: unknown) => {
      traceRows.push(raw);
      return Promise.resolve({ id: `t${traceRows.length}`, ...(raw as object) });
    },
  },
  sessionItems: {
    list: () => Promise.resolve([...session]),
    append: (_u: string, items: unknown[]) => {
      session.push(...items);
      return Promise.resolve();
    },
    popLast: () => Promise.resolve(session.pop() ?? null),
    clear: () => {
      session.length = 0;
      return Promise.resolve();
    },
  },
  demands: {
    findOpenByUser: () => Promise.resolve([]),
    create: (raw: unknown) => Promise.resolve({ id: 'preview-demand', ...(raw as object) }),
    update: (_id: string, raw: unknown) =>
      Promise.resolve({ id: 'preview-demand', ...(raw as object) }),
  },
  suppliers: { findCandidates: () => Promise.resolve([]), findByIds: () => Promise.resolve([]) },
  matches: { replaceForDemand: () => Promise.resolve([]) },
  supplies: { findActive: () => Promise.resolve([]) },
  outbound: {
    countSentToTargetSince: () => Promise.resolve(0),
    create: (raw: unknown, status: string) => {
      if (status !== 'dry_run') throw new Error('preview refuses outbound');
      const row = { id: 'preview-outbound', status, ...outboundDraftSchema.parse(raw) };
      drafts.push(row);
      return Promise.resolve(row);
    },
  },
} as unknown as Repositories;
configureModelProvider(env, [createTraceProcessor({ traces: repos.traces, logger })]);
const marketSearch = createMarketSearch({
  logger,
  fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const res = await fetch(input, init);
    requests.push({
      path: url.pathname,
      keyword: url.searchParams.get('keyword'),
      tradeType: url.searchParams.get('tradeType'),
      status: res.status,
    });
    return res;
  },
});
const ctx: MatchContext = {
  userId: 'preview-user',
  chatId: 'preview-chat',
  groupId: null,
  phase: 0,
  sourceMessageId: 'preview-source',
  recentReplies: [],
  demand: { category, confidence: 1, lang: 'zh' },
};
const started = Date.now();
const outputPath = process.argv[3] ?? '/tmp/matchbot-market-preview.json';
const save = (status: string, result?: unknown) =>
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        status,
        result,
        elapsedMs: Date.now() - started,
        queries: ctx.marketQueries,
        details: ctx.marketDetailIds,
        listings: ctx.marketListings,
        drafts,
        requests,
        traces: traceRows,
        session,
      },
      null,
      2,
    ),
  );
const watchdog = setTimeout(() => {
  save('timeout');
  logger.error({ outputPath }, 'preview exceeded 180s limit');
  process.exit(2);
}, 180_000);
try {
  const result = await runInbound({
    deps: {
      env,
      repos,
      marketSearch,
      logger,
      thresholds: DEFAULT_THRESHOLDS,
      jev: { evaluate: () => Promise.reject(new Error('preview does not call Jev')) },
      evaluateOutbound: () => Promise.reject(new Error('Phase 0 has no outbound model evaluation')),
    },
    ctx,
    input,
  });
  save('completed', result);
  logger.info(
    {
      outputPath,
      elapsedMs: Date.now() - started,
      queries: ctx.marketQueries?.length ?? 0,
      details: ctx.marketDetailIds?.length ?? 0,
      listings: ctx.marketListings?.length ?? 0,
      drafts: drafts.length,
    },
    'market preview completed',
  );
} catch (error) {
  save(error instanceof Error ? error.name : 'failed');
  logger.error(
    { outputPath, errorKind: error instanceof Error ? error.name : 'UnknownError' },
    'preview failed',
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
