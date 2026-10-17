/** Immutable main 254e462, frozen synthetic conversations/sources, no Telegram or public search. */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  runInbound,
  type AgentDeps,
  type MatchContext,
} from '/Users/huanghaibin/.codex/worktrees/task-agent-baseline/match_bot/packages/agent/dist/index.js';
import {
  createRepositories,
  getPrisma,
  disconnectPrisma,
} from '/Users/huanghaibin/.codex/worktrees/task-agent-baseline/match_bot/packages/db/dist/index.js';
import {
  createJevClient,
  evaluateOutbound,
} from '/Users/huanghaibin/.codex/worktrees/task-agent-baseline/match_bot/packages/jev/dist/index.js';
import { DEFAULT_THRESHOLDS } from '/Users/huanghaibin/.codex/worktrees/task-agent-baseline/match_bot/packages/gating/dist/index.js';
import {
  loadEnv,
  createLogger,
} from '/Users/huanghaibin/.codex/worktrees/task-agent-baseline/match_bot/packages/shared/dist/index.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';

const baselineRoot = '/Users/huanghaibin/.codex/worktrees/task-agent-baseline/match_bot';
const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: baselineRoot,
  encoding: 'utf8',
  timeout: 10000,
}).trim();
if (!baselineSha.startsWith('254e462') || AGENT_VERSION !== '0.15.1')
  throw new Error('wrong baseline');
if (
  execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: baselineRoot,
    encoding: 'utf8',
    timeout: 10000,
  }).trim()
)
  throw new Error('baseline source modified');
const sampleId = z.enum(['desk_chair', 'cat_housing', 'beginner_bad']).parse(process.argv[2]);
const output = z.string().min(1).parse(process.argv[3]);
const env = loadEnv(),
  destination = new URL(env.DATABASE_URL);
if (destination.hostname !== '127.0.0.1' || destination.pathname !== '/matchbot_baseline_preview')
  throw new Error('isolated local preview DB required');
// Baseline consumes only frozen user turns/quote anchors, never the newer Task ledger or its grader.
const baselineInputsSchema = z.object({
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        turns: z
          .array(
            z.object({
              input: z.string().min(1),
              expect: z.object({ replyTo: z.string().min(1).optional() }),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
const conversations = baselineInputsSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../packages/eval/fixtures/task-agent/conversations.json', import.meta.url),
      'utf8',
    ),
  ),
);
const corpus = z
  .object({
    version: z.literal(1),
    cases: z.array(
      z.object({
        id: z.string(),
        aliases: z.array(z.string()),
        forbiddenIds: z.array(z.string()),
        listings: z.array(marketListingSchema),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../packages/eval/fixtures/task-agent/source-corpus.json', import.meta.url),
        'utf8',
      ),
    ),
  );
const sample = conversations.cases.find((row) => row.id === sampleId)!,
  sources = corpus.cases.find((row) => row.id === sampleId)!;
if (!sample || !sources || sample.turns.length !== 5) throw new Error('missing frozen case');
const logger = createLogger('p27-baseline-preview', 'warn'),
  prisma = getPrisma(env.DATABASE_URL),
  repos = createRepositories(prisma);
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const queries: unknown[] = [],
  details: string[] = [],
  results: unknown[] = [];
const deps: AgentDeps = {
  env,
  repos,
  logger,
  answerRequests: true,
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
      const matches = sources.aliases.some((alias) =>
        args.keyword.toLowerCase().includes(alias.toLowerCase()),
      );
      const items =
        matches && args.page === 1
          ? sources.listings.filter(
              (row) => args.tradeType === 'ANY' || args.tradeType === row.tradeType,
            )
          : [];
      return { items, hasNext: false, total: items.length };
    },
    detail: async (id) => {
      details.push(id);
      const item = sources.listings.find((row) => row.id === id);
      if (!item) throw new Error('unknown synthetic source');
      return item;
    },
  },
};
const runId = randomUUID(),
  started = Date.now();
const save = (status: string) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        sampleId,
        baselineSha,
        agentVersion: AGENT_VERSION,
        model: env.DEEPSEEK_MODEL,
        jevModel: env.JEV_MODEL,
        corpusHash: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
        status,
        elapsedMs: Date.now() - started,
        boundary:
          'immutable old main; real generation/Jev/SDK/PG/outbound gates; frozen source corpus; per-source outbox simulated transport; no worker inbound or Telegram; baseline has no Task ledger, not graded as candidate Task compliance',
        limits: { perTurnMs: 150000, toolRounds: 12, sourceQueries: 8, sourceDetails: 8 },
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
}, 900000);
let turnWatchdog: ReturnType<typeof setTimeout> | undefined;
try {
  const user = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p27-baseline-' + runId,
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p27-baseline-' + runId,
    name: 'synthetic baseline preview',
  });
  await prisma.group.update({ where: { id: group.id }, data: { phase: 2, isActive: true } });
  let previousReply: string | undefined;
  for (const [index, turn] of sample.turns.entries()) {
    const t0 = Date.now(),
      beforeQueries = queries.length;
    turnWatchdog = setTimeout(() => {
      save('turn_timeout');
      process.exit(2);
    }, 150000);
    const message = await repos.messages.create({
      userId: user.id,
      groupId: group.id,
      externalId: String(index + 1),
      text: turn.input,
      receivedAt: new Date(),
    });
    const ctx: MatchContext = {
      userId: user.id,
      groupId: group.id,
      chatId: group.externalId,
      phase: 2,
      sourceMessageId: message.id,
      recentReplies: [],
      addressedToBot: true,
      source: { messageId: String(index + 1), userId: user.externalId },
      ...(turn.expect.replyTo && previousReply ? { replyToBotText: previousReply } : {}),
    };
    const result = await runInbound({ deps, ctx, input: turn.input });
    await processor.forceFlush();
    const rows = await prisma.outboundMessage.findMany({
      where: { target: group.externalId, replyToMessageId: String(index + 1) },
      orderBy: { createdAt: 'asc' },
    });
    // Only this synthetic source's rows: never drain another concurrent preview's pending outbox.
    for (const row of rows) if (row.status === 'pending') await repos.outbound.markSent(row.id);
    const outbounds = await prisma.outboundMessage.findMany({
      where: { target: group.externalId, replyToMessageId: String(index + 1) },
      orderBy: { createdAt: 'asc' },
    });
    previousReply =
      outbounds.find((row) => row.status === 'sent' && row.kind !== 'reaction')?.text ??
      previousReply;
    results.push({
      index,
      input: turn.input,
      elapsedMs: Date.now() - t0,
      searches: queries.length - beforeQueries,
      result,
      failures: ctx.sourceFailures,
      outbounds: outbounds.map(({ text, kind, status }) => ({ text, kind, status })),
      traces: await prisma.decisionTrace.findMany({
        where: { inputRef: message.id },
        orderBy: { createdAt: 'asc' },
      }),
    });
    clearTimeout(turnWatchdog);
    turnWatchdog = undefined;
    save('running');
    logger.warn({ sampleId, turn: index, elapsedMs: Date.now() - t0 }, 'baseline turn completed');
  }
  save('completed');
} catch (error) {
  results.push({ error: error instanceof Error ? error.name : 'unknown' });
  save('failed');
  process.exitCode = 1;
} finally {
  if (turnWatchdog) clearTimeout(turnWatchdog);
  clearTimeout(watchdog);
  await processor.forceFlush();
  await disconnectPrisma();
}
