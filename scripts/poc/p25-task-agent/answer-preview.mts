/** Synthetic sources, real model/Jev and isolated DB. Phase 0, no Telegram or public search. */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  runInbound,
} from '../../../packages/agent/src/index.js';
import type { AgentDeps, MatchContext } from '../../../packages/agent/src/context.js';
import { createRepositories, getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { assessTaskReadiness } from '../../../packages/domain/src/index.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';

const env = loadEnv(),
  destination = new URL(env.DATABASE_URL);
if (destination.hostname !== '127.0.0.1' || destination.pathname !== '/matchbot_task_preview')
  throw new Error('isolated local preview DB required');
const logger = createLogger('p25-answer-preview', 'warn');
const prisma = getPrisma(env.DATABASE_URL),
  repos = createRepositories(prisma);
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const fixtures = [
  [
    'cat-home',
    'Stratford一居室整租',
    '出租：伦敦Stratford一居室整租\n费用：月租£1550，不含账单\n入住：2026年11月5日起\n要求：允许养一只猫，宠物许可会写入租约\n地点：Stratford, London',
    '£1550/月',
  ],
  [
    'no-pets-home',
    'Stratford一居室',
    '出租：伦敦Stratford一居室整租\n费用：月租£1500，不含账单\n入住：2026年11月1日起\n要求：不允许养猫或其他宠物\n地点：Stratford, London',
    '£1500/月',
  ],
].map(([id, title, description, priceLabel]) =>
  marketListingSchema.parse({
    id,
    title,
    description,
    priceLabel,
    tags: [],
    tradeType: 'SELL',
    status: 'ON_SALE',
    url: 'https://a2hmarket.ai/listings/' + id,
    sourceUrl: null,
    isRepost: false,
    availableFrom: null,
    availableUntil: null,
    sourcePublishedAt: '2026-10-16T00:00:00Z',
    createdAt: '2026-10-16T00:00:00Z',
  }),
);
const queries: unknown[] = [],
  details: string[] = [];
const deps: AgentDeps = {
  env,
  repos,
  logger,
  answerRequests: true,
  taskRequests: true,
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
  marketSearch: {
    find: async (args) => {
      queries.push(args);
      return { items: fixtures, hasNext: false, total: fixtures.length };
    },
    detail: async (id) => {
      details.push(id);
      const item = fixtures.find((n) => n.id === id);
      if (!item) throw new Error('unknown synthetic ID');
      return item;
    },
  },
};
const runId = randomUUID(),
  output = process.argv[2] ?? '/tmp/matchbot-task-answer-preview.json';
const hash = createHash('sha256');
for (const root of [
  'packages/agent/src',
  'packages/domain/src',
  'packages/jev/src',
  'packages/gating/src',
  'packages/db/src/repos',
])
  for (const name of readdirSync(root, { recursive: true })
    .filter((n) => n.endsWith('.ts'))
    .sort())
    hash.update(root + '/' + name).update(readFileSync(join(root, name)));
const sourceFingerprint = hash.digest('hex'),
  started = Date.now(),
  results: unknown[] = [];
const save = (status: string) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        sourceFingerprint,
        agentVersion: AGENT_VERSION,
        status,
        elapsedMs: Date.now() - started,
        boundary:
          'synthetic sources and user; real DeepSeek/Jev; isolated DB; Phase 0 dry_run; no Telegram or external search',
        fixtures,
        results,
        queries,
        details,
      },
      null,
      2,
    ),
  );
const watchdog = setTimeout(() => {
  save('timeout');
  process.exit(2);
}, 360000);
try {
  let previousTaskId: string | undefined;
  const user = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p25-answer-' + runId,
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p25-answer-' + runId,
    name: 'synthetic answer preview',
  });
  for (const [index, input] of [
    '想在Stratford找一居室，月租1600镑以内，11月5日入住，我有一只猫，必须允许养猫。',
    '预算不能增加，包账单更好，猫一定要能养。',
  ].entries()) {
    if (process.argv[3] === 'first' && index > 0) break;
    const accepted = await repos.executions.accept({
      userId: user.id,
      groupId: group.id,
      phase: 0,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: group.externalId,
        messageId: 'turn-' + index,
        text: input,
        receivedAt: new Date().toISOString(),
        addressedToBot: true,
      },
    });
    const message = accepted.message,
      claim = await repos.executions.claim({ userId: user.id, messageId: message.id });
    if (claim.kind !== 'acquired') throw new Error('preview execution claim unavailable');
    const ctx: MatchContext = {
      execution: claim.lease,
      userId: user.id,
      chatId: group.externalId,
      channel: 'telegram',
      groupId: group.id,
      phase: 0,
      sourceMessageId: message.id,
      recentReplies: [],
      addressedToBot: true,
    };
    const t0 = Date.now();
    const before = await prisma.outboundMessage.count({ where: { target: group.externalId } });
    try {
      const result = await runInbound({ deps, ctx, input });
      await repos.executions.finish({
        lease: claim.lease,
        status: result.kind === 'interrupted' ? 'waiting_approval' : 'completed',
        ...(result.kind === 'interrupted' ? { runStateId: result.runStateId } : {}),
      });
      await processor.forceFlush();
      const drafts = await prisma.outboundMessage.findMany({
        where: { target: group.externalId },
        orderBy: { createdAt: 'asc' },
      });
      const traces = await prisma.decisionTrace.findMany({
        where: { inputRef: message.id },
        orderBy: { createdAt: 'asc' },
      });
      const currentDrafts = drafts.slice(before),
        answer = currentDrafts[0];
      const checks = {
        oneDryDraft: currentDrafts.length === 1 && answer?.status === 'dry_run',
        substantiveAnswer: traces.some(
          (t) => t.kind === 'gate' && JSON.stringify(t.output).includes('request_answer'),
        ),
        sameTask: !!ctx.task && (!previousTaskId || ctx.task.id === previousTaskId),
        sourceTermsReady: !!ctx.task && assessTaskReadiness(ctx.task).ready,
        excludesWrongHouse: !!answer && !answer.text.includes('/listings/no-pets-home'),
        hasGoodLink: !!answer?.text.includes('/listings/cat-home'),
        noInternalRefs: !!answer && !/\bm\d+\b/.test(answer.text),
        doesNotCompleteUserGoal:
          !!ctx.task && ctx.task.status !== 'completed' && ctx.task.userConfirmation === null,
      };
      previousTaskId = ctx.task?.id;
      if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
      results.push({
        index,
        input,
        elapsedMs: Date.now() - t0,
        result,
        task: ctx.task,
        taskUpdate: ctx.taskUpdate,
        failures: ctx.sourceFailures,
        drafts,
        traces,
        checks,
      });
      logger.warn(
        { turn: index, elapsedMs: Date.now() - t0, drafts: drafts.length },
        'answer preview turn completed',
      );
    } catch (e) {
      await repos.executions.finish({
        lease: claim.lease,
        status: 'failed',
        errorCode: 'preview_failed',
      });
      results.push({
        index,
        input,
        elapsedMs: Date.now() - t0,
        error: e instanceof Error ? e.name : 'unknown',
      });
      process.exitCode = 1;
    }
    save('running');
  }
  save('completed');
} finally {
  clearTimeout(watchdog);
  await processor.forceFlush();
  await disconnectPrisma();
}
