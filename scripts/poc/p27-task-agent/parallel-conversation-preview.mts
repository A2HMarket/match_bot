/** Same synthetic owner, two tasks, real models/SDK/PG/gates, frozen public offers and simulated transport. */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  runInbound,
  type AgentDeps,
  type MatchContext,
} from '../../../packages/agent/src/index.js';
import { createRepositories, getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';
import { drainOutbound } from '../../../apps/bot/src/outbound-loop.js';
import { waitForPreviewOutbounds } from './preview-delivery.mjs';
const fixtureBytes = readFileSync(
  'packages/eval/fixtures/task-agent/parallel-conversation.json',
  'utf8',
);
const fixture = z
  .object({
    turns: z
      .array(
        z.object({
          input: z.string().min(1),
          target: z.enum(['furniture', 'housing', 'ambiguous']),
          replyTo: z.enum(['furniture', 'housing']).nullable(),
          completed: z.boolean().optional(),
        }),
      )
      .length(8),
  })
  .parse(JSON.parse(fixtureBytes));
const corpus = z
  .object({
    cases: z.array(
      z.object({
        id: z.string(),
        aliases: z.array(z.string()),
        listings: z.array(marketListingSchema),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync('packages/eval/fixtures/task-agent/source-corpus.json', 'utf8')));
const env = loadEnv(),
  destination = new URL(env.DATABASE_URL);
if (destination.hostname !== '127.0.0.1' || destination.pathname !== '/matchbot_task_preview')
  throw new Error('isolated preview DB required');
const logger = createLogger('p27-parallel-preview', 'warn'),
  prisma = getPrisma(env.DATABASE_URL),
  repos = createRepositories(prisma),
  processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const queries: unknown[] = [],
  details: string[] = [],
  results: unknown[] = [],
  draftChecks: unknown[] = [];
const deps: AgentDeps = {
  env,
  repos,
  logger,
  answerRequests: true,
  taskRequests: true,
  thresholds: DEFAULT_THRESHOLDS,
  evaluateOutbound: async (client, input) => {
    const verdict = await evaluateOutbound(client, input);
    draftChecks.push({ ...input, verdict });
    return verdict;
  },
  jev: createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    logger,
    traces: repos.traces,
    timeoutMs: 10000,
    maxRetries: 0,
  }),
  marketSearch: {
    find: async (args) => {
      queries.push(args);
      const items =
        args.page === 1
          ? corpus.cases
              .filter(
                (c) =>
                  ['desk_chair', 'cat_housing'].includes(c.id) &&
                  c.aliases.some((alias) =>
                    args.keyword.toLowerCase().includes(alias.toLowerCase()),
                  ),
              )
              .flatMap((c) => c.listings)
              .filter((row) => args.tradeType === 'ANY' || args.tradeType === row.tradeType)
          : [];
      return { items, hasNext: false, total: items.length };
    },
    detail: async (id) => {
      details.push(id);
      const row = corpus.cases.flatMap((c) => c.listings).find((item) => item.id === id);
      if (!row) throw new Error('unknown synthetic offer');
      return row;
    },
  },
};
const runId = randomUUID(),
  output = process.argv[2] ?? '/tmp/matchbot-parallel-conversation.json';
const save = (status: string) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        agentVersion: AGENT_VERSION,
        status,
        corpusHash: createHash('sha256').update(fixtureBytes).digest('hex'),
        boundary:
          'real generation/Jev/SDK/isolated PG; frozen synthetic users/offers; simulated transport; no worker inbound gate or Telegram',
        queries,
        details,
        draftChecks,
        results,
      },
      null,
      2,
    ),
  );
const timer = setTimeout(() => {
  save('timeout');
  process.exit(2);
}, 900000);
try {
  const user = await repos.users.upsertByExternal({
      channel: 'telegram',
      externalId: 'p27-parallel-' + runId,
    }),
    group = await repos.groups.upsert({
      channel: 'telegram',
      externalId: '-p27-preview-parallel-' + runId,
      name: 'synthetic parallel preview',
    });
  await prisma.group.update({ where: { id: group.id }, data: { phase: 2, isActive: true } });
  const access = {
      userId: user.id,
      scope: { channel: 'telegram' as const, chatId: group.externalId },
    },
    ids = new Map<string, string>(),
    anchors = new Map<string, string>();
  let receipt = 1000;
  for (const [index, turn] of fixture.turns.entries()) {
    const before = await Promise.all(
        [...ids].map(async ([alias, id]) => ({
          alias,
          task: await repos.tasks.findById({ access, id }),
        })),
      ),
      beforeQueries = queries.length;
    const anchor = turn.replyTo ? anchors.get(turn.replyTo) : undefined;
    if (turn.replyTo && !anchor) throw new Error('missing delivered task anchor');
    const accepted = await repos.executions.accept({
      userId: user.id,
      groupId: group.id,
      phase: 2,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: group.externalId,
        messageId: String(index + 1),
        text: turn.input,
        receivedAt: new Date().toISOString(),
        addressedToBot: true,
        ...(anchor ? { replyToMessageId: anchor } : {}),
      },
    });
    const claim = await repos.executions.claim({ userId: user.id, messageId: accepted.message.id });
    if (claim.kind !== 'acquired') throw new Error('claim unavailable');
    const ctx: MatchContext = {
      execution: claim.lease,
      userId: user.id,
      chatId: group.externalId,
      groupId: group.id,
      phase: 2,
      sourceMessageId: accepted.message.id,
      recentReplies: [],
      addressedToBot: true,
      source: { messageId: String(index + 1), userId: user.externalId },
      ...(anchor ? { replyToMessageId: anchor } : {}),
    };
    const result = await runInbound({ deps, ctx, input: turn.input });
    await repos.executions.finish({
      lease: claim.lease,
      status: result.kind === 'interrupted' ? 'waiting_approval' : 'completed',
      ...(result.kind === 'interrupted' ? { runStateId: result.runStateId } : {}),
    });
    await processor.forceFlush();
    await drainOutbound({
      repos,
      logger,
      defaultPhase: 2,
      sender: {
        send: async (row, options) => {
          if (!row.target.startsWith('-p27-preview-'))
            throw new Error('non-preview target rejected');
          if (!(await options.beforeSend())) return { kind: 'not_started' };
          return row.kind === 'reaction'
            ? { kind: 'reaction', externalMessageId: null }
            : { kind: 'message', externalMessageId: String(++receipt) };
        },
      },
    });
    const outbounds = await waitForPreviewOutbounds({
        prisma,
        sourceMessageId: accepted.message.id,
      }),
      sent = outbounds.filter((row) => row.status === 'sent'),
      text = sent.map((row) => row.text).join('\n'),
      issues: string[] = [];
    if (!sent.length) issues.push('no_sent_response');
    if (turn.target === 'ambiguous') {
      if (!['ambiguous', 'unbound'].includes(ctx.taskUpdate?.kind ?? ''))
        issues.push('ambiguous_reference_mutated_task');
      if (queries.length !== beforeQueries) issues.push('searched_before_resolving_task');
    } else {
      const expected = ids.get(turn.target);
      if (!ctx.task || (expected && ctx.task.id !== expected)) issues.push('wrong_selected_task');
      if (ctx.task) {
        ids.set(turn.target, ctx.task.id);
        if (ctx.task.category !== (turn.target === 'housing' ? 'housing' : 'second_hand'))
          issues.push('task_category_drift');
        if (turn.completed && ctx.task.status !== 'completed')
          issues.push('explicit_task_completion_missing');
        if (!turn.completed && ctx.task.status === 'completed')
          issues.push('premature_task_completion');
        if (!turn.completed && !/https:\/\/a2hmarket\.ai\/listings\//.test(text))
          issues.push('no_actionable_source');
        if (index === 5 && text.includes('/listings/task-eval-chair-'))
          issues.push('completed_chair_recommended');
      }
      const delivered = sent.find((row) => row.externalMessageId);
      if (delivered?.externalMessageId) anchors.set(turn.target, delivered.externalMessageId);
    }
    for (const item of before)
      if (item.alias !== turn.target) {
        const after = await repos.tasks.findById({ access, id: item.task!.id });
        if (after?.revision !== item.task?.revision)
          issues.push('unrelated_task_changed:' + item.alias);
      }
    const state = await Promise.all(
      [...ids].map(async ([alias, id]) => ({
        alias,
        task: await repos.tasks.findById({ access, id }),
      })),
    );
    results.push({
      index,
      input: turn.input,
      target: turn.target,
      taskUpdate: ctx.taskUpdate,
      selectedTaskId: ctx.task?.id,
      state,
      issues,
      outbounds: outbounds.map(({ text, kind, status }) => ({ text, kind, status })),
      traces: await prisma.decisionTrace.findMany({
        where: { inputRef: accepted.message.id },
        orderBy: { createdAt: 'asc' },
      }),
    });
    if (issues.length) process.exitCode = 1;
    save('running');
    logger.warn({ turn: index, issues }, 'parallel preview turn complete');
  }
  if (new Set(ids.values()).size !== 2) throw new Error('expected two independent tasks');
  save('completed');
} catch (error) {
  results.push({ error: error instanceof Error ? error.name : 'unknown' });
  save('failed');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await processor.forceFlush();
  await disconnectPrisma();
}
