/** P14 真实模型/搜索预览：仓储与会话只在内存，Phase 0，没有 Telegram 发送或生产写入。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  configureModelProvider,
  createTraceProcessor,
  runInbound,
} from '../../../packages/agent/src/index.js';
import type { MatchContext } from '../../../packages/agent/src/context.js';
import type { Repositories } from '../../../packages/db/src/index.js';
import { outboundDraftSchema } from '../../../packages/domain/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { createLogger, loadEnv } from '../../../packages/shared/src/index.js';
import { createXhsSearch } from '../../../packages/websearch/src/index.js';
import { getXhsPassages } from '../../../packages/agent/src/xhs-evidence.js';
import { xhsResearchQuerySchema } from '../../../packages/agent/src/xhs-research.js';

const env = { ...loadEnv(), XHS_RESEARCH_ENABLED: true };
const queryInput =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '伦敦看展有哪些推荐';
if (!env.SANDBASE_API_KEY) throw new Error('SANDBASE_API_KEY is required');
const logger = createLogger('research-preview');
const traces: unknown[] = [];
const drafts: unknown[] = [];
const session: unknown[] = [];
const requests: Array<{ path: string; keyword: string | null; status: number }> = [];
const repos = {
  traces: {
    create: (input: unknown) => {
      traces.push(input);
      return Promise.resolve({ id: `t${traces.length}`, ...(input as object) });
    },
  },
  sessionItems: {
    list: () => Promise.resolve([...session]),
    append: (_id: string, items: unknown[]) => {
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
    create: (input: unknown) => Promise.resolve({ id: 'preview-demand', ...(input as object) }),
    update: (_id: string, input: unknown) =>
      Promise.resolve({ id: 'preview-demand', ...(input as object) }),
  },
  suppliers: { findCandidates: () => Promise.resolve([]), findByIds: () => Promise.resolve([]) },
  matches: { replaceForDemand: () => Promise.resolve([]) },
  supplies: { findActive: () => Promise.resolve([]) },
  outbound: {
    countSentToTargetSince: () => Promise.resolve(0),
    create: (raw: unknown, status: string) => {
      if (status !== 'dry_run') throw new Error('preview refuses non-dry-run output');
      const draft = {
        id: `preview-${drafts.length + 1}`,
        status,
        ...outboundDraftSchema.parse(raw),
      };
      drafts.push(draft);
      return Promise.resolve(draft);
    },
  },
} as unknown as Repositories;
configureModelProvider(env, [createTraceProcessor({ traces: repos.traces, logger })]);
const xhsSearch = createXhsSearch({
  apiKey: env.SANDBASE_API_KEY,
  logger,
  fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const response = await fetch(input, init);
    requests.push({
      path: url.pathname,
      keyword:
        z
          .object({ keyword: z.string().optional() })
          .parse(init?.body ? JSON.parse(String(init.body)) : {}).keyword ?? null,
      status: response.status,
    });
    return response;
  },
});
const ctx: MatchContext = {
  userId: 'preview-user',
  chatId: 'preview-chat',
  groupId: null,
  phase: 0,
  sourceMessageId: 'preview-source',
  recentReplies: [],
  demand: { category: 'other', confidence: 1, lang: 'zh' },
};
const isCached = process.argv.includes('--cached');
if (isCached) {
  const cached = z
    .object({
      notes: z.array(
        z.object({
          ref: z.string(),
          title: z.string(),
          desc: z.string(),
          author: z.string(),
          likes: z.number(),
          url: z.url(),
          isDetailLoaded: z.boolean().optional(),
        }),
      ),
      queries: z.array(xhsResearchQuerySchema),
      detailRefs: z.array(z.string()).optional(),
    })
    .parse(JSON.parse(readFileSync('/tmp/matchbot-xhs-research-cached.json', 'utf8')));
  ctx.xhsNotes = cached.notes.map(({ isDetailLoaded, ...note }) => ({
    ...note,
    ...(isDetailLoaded === undefined ? {} : { isDetailLoaded }),
  }));
  ctx.xhsQueries = cached.queries;
  ctx.xhsDetailRefs =
    cached.detailRefs ?? cached.notes.filter((n) => n.isDetailLoaded).map((n) => n.ref);
}
const started = Date.now();
const outputPath = '/tmp/matchbot-xhs-research-live.json';
const watchdog = setTimeout(() => {
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        status: 'timeout',
        elapsedMs: Date.now() - started,
        queries: ctx.xhsQueries,
        notes: ctx.xhsNotes,
        detailRefs: ctx.xhsDetailRefs,
        drafts,
        traces,
        requests,
      },
      null,
      2,
    ),
  );
  logger.error({ outputPath }, 'research preview exceeded 180-second limit');
  process.exit(2);
}, 180_000);
try {
  const result = await runInbound({
    deps: {
      env,
      repos,
      xhsSearch,
      logger,
      thresholds: DEFAULT_THRESHOLDS,
      jev: { evaluate: () => Promise.reject(new Error('preview does not call Jev')) },
      evaluateOutbound: () => Promise.reject(new Error('Phase 0 does not call outbound evaluator')),
    },
    ctx,
    input: isCached
      ? `${queryInput}。研究已完成，已读额度${ctx.xhsDetailRefs?.length ?? 0}/12，请基于以下已读全文直接综合，按多来源覆盖筛选具体选项，不再搜索：${JSON.stringify(ctx.xhsNotes?.filter((n) => n.isDetailLoaded !== false).map((n) => ({ ref: n.ref, title: n.title, passages: getXhsPassages(n) })))}`
      : queryInput,
  });
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        result,
        elapsedMs: Date.now() - started,
        queries: ctx.xhsQueries,
        notes: ctx.xhsNotes,
        detailRefs: ctx.xhsDetailRefs,
        drafts,
        traces,
        requests,
        session,
      },
      null,
      2,
    ),
  );
  logger.info(
    {
      outputPath,
      elapsedMs: Date.now() - started,
      queries: ctx.xhsQueries?.length ?? 0,
      notes: ctx.xhsNotes?.length ?? 0,
      drafts: drafts.length,
      requestCount: requests.length,
      result: result.kind,
    },
    'research preview completed',
  );
} catch (error) {
  const scrub = (message: string) =>
    [env.DEEPSEEK_API_KEY, env.JEV_API_KEY, env.TELEGRAM_BOT_TOKEN, env.SANDBASE_API_KEY ?? '']
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        status: 'failed',
        error: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? scrub(error.message) : 'UnknownError',
        cause:
          error instanceof Error && error.cause instanceof Error
            ? scrub(error.cause.message)
            : null,
        failureState:
          error instanceof Error &&
          'state' in error &&
          error.state &&
          typeof error.state === 'object' &&
          'toString' in error.state &&
          typeof error.state.toString === 'function'
            ? (JSON.parse(scrub(error.state.toString())) as unknown)
            : null,
        elapsedMs: Date.now() - started,
        queries: ctx.xhsQueries,
        notes: ctx.xhsNotes,
        detailRefs: ctx.xhsDetailRefs,
        drafts,
        traces,
        requests,
        session,
      },
      null,
      2,
    ),
  );
  logger.error(
    { outputPath, errorKind: error instanceof Error ? error.name : 'UnknownError' },
    'research preview failed',
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
