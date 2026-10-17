/** Complete synthetic XHS/task path: actual SDK, models, PG and gates; simulated sources/transport only. */
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
import { drainOutbound } from '../../../apps/bot/src/outbound-loop.js';
import { waitForPreviewOutbounds, previewExternalMessageId } from './preview-delivery.mjs';
const fixtureBytes = readFileSync(
  'packages/eval/fixtures/task-agent/xhs-conversation.json',
  'utf8',
);
const fixture = z
  .object({
    turns: z.array(z.string().min(1)).length(3),
    notes: z
      .array(
        z.object({
          ref: z.string(),
          title: z.string(),
          desc: z.string(),
          author: z.string(),
          likes: z.number(),
          url: z.string().url(),
        }),
      )
      .length(4),
  })
  .parse(JSON.parse(fixtureBytes));
const env = loadEnv(),
  destination = new URL(env.DATABASE_URL);
if (destination.hostname !== '127.0.0.1' || destination.pathname !== '/matchbot_task_preview')
  throw new Error('isolated preview DB required');
const logger = createLogger('p27-xhs-conversation', 'warn'),
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
  taskRequests: true,
  answerRequests: true,
  thresholds: DEFAULT_THRESHOLDS,
  evaluateOutbound,
  jev: createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    logger,
    traces: repos.traces,
    timeoutMs: 10000,
    maxRetries: 0,
  }),
  xhsSearch: {
    find: async (args) => {
      queries.push(args);
      return args.page === 2
        ? []
        : fixture.notes
            .filter((note) => !args.excludeUrls?.includes(note.url))
            .map((note) => ({ ...note, desc: note.desc.slice(0, 70), isDetailLoaded: false }));
    },
    readNote: async (note) => {
      details.push(note.url);
      const original = fixture.notes.find((row) => row.url === note.url);
      return original ? { ...original, ref: note.ref, isDetailLoaded: true } : null;
    },
  },
};
const runId = randomUUID(),
  output = process.argv[2] ?? '/tmp/matchbot-xhs-conversation.json';
const save = (status: string) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        agentVersion: AGENT_VERSION,
        corpusHash: createHash('sha256').update(fixtureBytes).digest('hex'),
        status,
        boundary:
          'synthetic XHS discovery cards/full notes, real DeepSeek/Jev/SDK/PG/outbound gates; simulated sender, no public source calls or Telegram',
        results,
        queries,
        details,
      },
      null,
      2,
    ),
  );
const timer = setTimeout(() => {
  save('timeout');
  process.exit(2);
}, 600000);
try {
  const user = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p27-xhs-' + runId,
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p27-preview-xhs-' + runId,
    name: 'synthetic XHS preview',
  });
  await prisma.group.update({ where: { id: group.id }, data: { phase: 2, isActive: true } });
  const access = {
    userId: user.id,
    scope: { channel: 'telegram' as const, chatId: group.externalId },
  };
  let firstTask: string | undefined, previousReply: string | undefined;
  for (const [index, input] of fixture.turns.entries()) {
    const beforeQueries = queries.length,
      beforeDetails = details.length;
    const accepted = await repos.executions.accept({
      userId: user.id,
      groupId: group.id,
      phase: 2,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: group.externalId,
        messageId: String(index + 1),
        text: input,
        receivedAt: new Date().toISOString(),
        addressedToBot: true,
        ...(previousReply ? { replyToMessageId: previousReply } : {}),
      },
    });
    const claim = await repos.executions.claim({ userId: user.id, messageId: accepted.message.id });
    if (claim.kind !== 'acquired') throw new Error('preview claim unavailable');
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
      ...(previousReply ? { replyToMessageId: previousReply } : {}),
    };
    const result = await runInbound({ deps, ctx, input });
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
            throw new Error('non-preview destination rejected');
          if (!(await options.beforeSend())) return { kind: 'not_started' };
          return row.kind === 'reaction'
            ? { kind: 'reaction', externalMessageId: null }
            : { kind: 'message', externalMessageId: previewExternalMessageId(row.id) };
        },
      },
    });
    const outbounds = await waitForPreviewOutbounds({
      prisma,
      sourceMessageId: accepted.message.id,
    });
    const sent = outbounds.filter((row) => row.status === 'sent'),
      text = sent.map((row) => row.text).join('\n');
    const task = ctx.task ? await repos.tasks.findById({ access, id: ctx.task.id }) : null;
    const issues: string[] = [];
    firstTask ??= task?.id;
    if (!task || task.id !== firstTask) issues.push('task_not_continued');
    if (!sent.length) issues.push('no_sent_response');
    if (index < 2) {
      if (!task?.evidence.some((e) => e.sourceRef.startsWith('xhs:')))
        issues.push('xhs_evidence_not_persisted');
      if (task?.status === 'completed') issues.push('premature_user_completion');
      if (!fixture.notes.some((note) => text.includes(note.url))) issues.push('no_source_link');
      if (!ctx.xhsNotes?.some((note) => note.isDetailLoaded)) issues.push('no_full_note_read');
      if (ctx.taskProgressVersion !== task?.requirementsVersion)
        issues.push('current_conditions_not_checked');
    } else {
      if (task?.status !== 'completed') issues.push('explicit_completion_not_applied');
      if (queries.length !== beforeQueries || details.length !== beforeDetails)
        issues.push('research_after_completion');
    }
    if (issues.length) process.exitCode = 1;
    results.push({
      index,
      input,
      result,
      task,
      issues,
      failures: ctx.sourceFailures,
      validatedEntities: ctx.xhsValidatedRecommendations,
      outbounds: outbounds.map(({ text, kind, status }) => ({ text, kind, status })),
      traces: await prisma.decisionTrace.findMany({
        where: { inputRef: accepted.message.id },
        orderBy: { createdAt: 'asc' },
      }),
    });
    previousReply = sent.find((row) => row.externalMessageId)?.externalMessageId ?? previousReply;
    save('running');
    logger.warn({ turn: index, issues }, 'XHS preview turn complete');
  }
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
