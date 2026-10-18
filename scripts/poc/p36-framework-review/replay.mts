/** Real model/Jev and runInbound, frozen public tool responses, memory tasks/session/outbox. No sender. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { loadEnv, decrypt, createLogger } from '../../../packages/shared/src/index.js';
import {
  taskSchema,
  recordTaskProgress,
  reviseTaskRequirements,
} from '../../../packages/domain/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import {
  configureModelProvider,
  createTraceProcessor,
  createMatchAgent,
  runInbound,
  AGENT_VERSION,
  type AgentDeps,
  type MatchContext,
} from '../../../packages/agent/src/index.js';
import { researchContextSchema } from '../../../packages/agent/src/restore-search-context.js';
import { buildDeliveryPacket } from '../../../packages/agent/src/delivery-context.js';
import { replyToRequestTool } from '../../../packages/agent/src/tools/reply-to-request.js';
const caseId = z.enum(['gp-registration', 'printer', 'family-exhibition']).parse(process.argv[2]);
const mode = z
  .enum([
    'full',
    'compact-full',
    'writer-diagnostic',
    'writer-recheck',
    'writer-final',
    'clock-regression',
  ])
  .parse(process.argv[3] ?? 'full');
const output = 'logs/p36/replay-' + caseId + (mode === 'full' ? '' : '-' + mode) + '.json',
  budgetFile = 'logs/p36/replay-budget.json';
if (existsSync(output)) throw new Error('case_already_attempted');
const env = loadEnv(),
  url = new URL(env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('local_database_required');
url.pathname = '/matchbot_actor_lab';
const db = createPrisma(url.toString()),
  repos = createRepositories(db),
  logger = createLogger('p36-replay', 'silent');
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const budgetSchema = z.object({
  limit: z.literal(200000),
  used: z.number().nonnegative(),
  refs: z.array(z.string()),
  uncertain: z.boolean(),
});
const budget = existsSync(budgetFile)
  ? budgetSchema.parse(JSON.parse(readFileSync(budgetFile, 'utf8')))
  : { limit: 200000 as const, used: 0, refs: [], uncertain: false };
if (budget.uncertain) throw new Error('prior_call_usage_uncertain');
const saveBudget = () =>
  writeFileSync(budgetFile, JSON.stringify(budget, null, 2) + '\n', { mode: 0o600 });
const data = z
  .object({
    messages: z.array(z.object({ executionSnapshot: z.string().nullable() })),
    tasks: z.array(taskSchema),
  })
  .parse(
    JSON.parse(
      readFileSync(
        'logs/p35/live-aa2adec9-c00c-49d2-b79d-37d4109d82dd/' + caseId + '.json',
        'utf8',
      ),
    ),
  );
// Decrypted data stays in memory. Reports contain counters and the synthetic reply, never the checkpoint/prompt.
const checkpoint = z
  .object({ taskId: z.string(), research: researchContextSchema })
  .parse(JSON.parse(decrypt(data.messages[0]!.executionSnapshot!, env.SNAPSHOT_KEY!)));
const prior = data.tasks.find((t) => t.id === checkpoint.taskId)!;
const input = checkpoint.research.currentRequest!.text;
const ref = 'p36:' + randomUUID() + ':' + caseId;
let task = taskSchema.parse({
  ...prior,
  id: 'p36-' + caseId,
  ownerUserId: 'p36-synthetic',
  scope: { channel: 'telegram', chatId: '-3600000001' },
  revision: 0,
  requirementsVersion: 0,
  status: 'active',
  evidence: [],
  goals: prior.goals.map((g) => ({
    ...g,
    criteria: g.criteria.map((c) => ({
      ...c,
      status: 'unknown',
      evidenceRefs: [],
      conflictingEvidenceRefs: [],
    })),
  })),
  pendingQuestion: null,
  nextStep: undefined,
  delivery: { status: 'none', level: 'none' },
});
const ctx: MatchContext = {
  userId: task.ownerUserId,
  chatId: task.scope.chatId,
  groupId: null,
  phase: 2,
  sourceMessageId: ref,
  recentReplies: [],
  addressedToBot: true,
  execution: { userId: task.ownerUserId, messageId: ref, token: randomUUID(), fence: 1 },
};
const rows: Array<{ text: string; status: string; kind: string }> = [],
  items: unknown[] = [],
  gates: Array<{ gate: string; decision?: unknown; reason?: unknown; result?: unknown }> = [],
  calls: Array<{ stage: string; inputTokens: number; outputTokens: number }> = [];
const proposals: Array<{ kind: string; text: string; refs: string[] }> = [];
let informationCalls = 0,
  marketCalls = 0,
  detailCalls = 0;
const baseDeps = { env, repos, logger, thresholds: DEFAULT_THRESHOLDS } as AgentDeps;
// Reuse the SDK's configured provider; the wrapper only enforces a conservative byte reserve and records usage.
const provider = createMatchAgent(baseDeps, { phase: 0 }).runner.config.modelProvider;
const priorPrompts: Array<{ chunks: string[]; tokens: number }> = [];
let budgetBlocked = false;
const modelProvider: NonNullable<AgentDeps['modelProvider']> = {
  getModel: async (name) => {
    const model = await provider.getModel(name);
    return {
      getStreamedResponse: () => {
        throw new Error('streaming_disabled_for_budgeted_replay');
      },
      getResponse: async (request) => {
        let reserve =
          Buffer.byteLength(
            JSON.stringify({
              instructions: request.systemInstructions,
              input: request.input,
              tools: request.tools,
            }),
          ) + 12000;
        const chunks = [
          ...(request.systemInstructions ?? '').split('\n'),
          ...request.tools.map((t) => JSON.stringify(t)),
          ...(typeof request.input === 'string'
            ? [request.input]
            : request.input.map((i) => JSON.stringify(i))),
        ];
        // Exact unchanged chunks need not be counted again at the one-byte-per-token ceiling.
        // Retain the entire observed prior input count; add every changed byte plus framing/output reserve.
        for (const previous of priorPrompts) {
          const remaining = new Map<string, number>();
          for (const chunk of previous.chunks)
            remaining.set(chunk, (remaining.get(chunk) ?? 0) + 1);
          let added = 0;
          for (const chunk of chunks) {
            const count = remaining.get(chunk) ?? 0;
            if (count) remaining.set(chunk, count - 1);
            else added += Buffer.byteLength(chunk);
          }
          reserve = Math.min(
            reserve,
            previous.tokens + added + 64 * (chunks.length + previous.chunks.length) + 12000,
          );
        }
        if (reserve > budget.limit - budget.used) {
          budgetBlocked = true;
          throw new Error('replay_budget_reserve');
        }
        budget.uncertain = true;
        saveBudget();
        const response = await model.getResponse({
          ...request,
          modelSettings: { ...request.modelSettings, maxTokens: 2400 },
        });
        const inputTokens = response.usage.inputTokens,
          outputTokens = response.usage.outputTokens;
        if (!Number.isFinite(inputTokens + outputTokens) || inputTokens + outputTokens <= 0)
          throw new Error('usage_missing');
        budget.used += inputTokens + outputTokens;
        priorPrompts.push({ chunks, tokens: inputTokens });
        budget.uncertain = false;
        saveBudget();
        for (const item of response.output) {
          const call = z
            .object({
              type: z.literal('function_call'),
              name: z.literal('reply_to_request'),
              arguments: z.string(),
            })
            .safeParse(item);
          if (call.success) {
            let raw: unknown;
            try {
              raw = JSON.parse(call.data.arguments);
            } catch {
              raw = null;
            }
            const draft = z
              .object({ kind: z.string(), text: z.string().max(2000), refs: z.array(z.string()) })
              .safeParse(raw);
            if (draft.success) proposals.push(draft.data);
          }
        }
        calls.push({
          stage: request.systemInstructions?.includes('DELIVERY STAGE')
            ? 'delivery'
            : request.tools.some((t) => t.type === 'function' && t.name === 'search_information')
              ? 'research'
              : 'planning',
          inputTokens,
          outputTokens,
        });
        return response;
      },
    };
  },
};
const frozen = checkpoint.research;
const deps = {
  ...baseDeps,
  modelProvider,
  answerRequests: true,
  taskRequests: true,
  env: { ...env, OUTBOUND_UNSURE_ACTION: 'drop' },
  jev: createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    traces: repos.traces,
    logger,
    timeoutMs: 10000,
    maxRetries: 0,
  }),
  evaluateOutbound,
  repos: {
    ...repos,
    forExecution: () => deps.repos,
    executions: {
      ...repos.executions,
      recoveryFlags: () => Promise.resolve({ outboundBlocked: false, answerInputExhausted: false }),
      saveCheckpoint: () => Promise.resolve(true),
    },
    traces: {
      ...repos.traces,
      create: async (p: Parameters<typeof repos.traces.create>[0]) => {
        const s = z
          .object({
            gate: z.string(),
            decision: z.unknown().optional(),
            reason: z.unknown().optional(),
            result: z.unknown().optional(),
            detail: z.array(z.string()).optional(),
          })
          .safeParse(p.output);
        if (s.success) gates.push(s.data);
        return repos.traces.create(p);
      },
    },
    sessionItems: {
      list: () => Promise.resolve([...items]),
      append: (_u: string, next: unknown[]) => {
        items.push(...next);
        return Promise.resolve();
      },
      popLast: () => Promise.resolve(items.pop() ?? null),
      clear: () => {
        items.length = 0;
        return Promise.resolve();
      },
    },
    tasks: {
      ...repos.tasks,
      findAppliedTurn: () => Promise.resolve(null),
      findOpenByScope: () => Promise.resolve([task]),
      planTurn: (p: Parameters<typeof repos.tasks.planTurn>[0]) => {
        if (p.taskId !== task.id) throw new Error('fixture_task_reference');
        if (p.patch)
          task = reviseTaskRequirements({
            task,
            patch: p.patch,
            source: { messageId: ref, text: input },
          });
        return Promise.resolve({ kind: 'applied', task });
      },
      recordProgress: (p: Parameters<typeof repos.tasks.recordProgress>[0]) => {
        task = recordTaskProgress({ task, ...p.progress });
        return Promise.resolve({ kind: 'applied', task });
      },
    },
    outbound: {
      ...repos.outbound,
      countSentToTargetSince: () => Promise.resolve(0),
      create: (draft: Parameters<typeof repos.outbound.create>[0], status: string) => {
        rows.push({ text: draft.text, status, kind: draft.kind });
        return Promise.resolve({ ...draft, id: 'memory-p36', status });
      },
    },
  },
  webSearch: {
    find: () => Promise.resolve([]),
    research: (p: { domains?: string[] }) => {
      informationCalls++;
      const sources = (frozen.knowledgeSources ?? [])
        .filter(
          (s) =>
            !p.domains?.length ||
            p.domains.some(
              (d) => new URL(s.url).hostname === d || new URL(s.url).hostname.endsWith('.' + d),
            ),
        )
        .map(({ title, url, text }) => ({ title, url, text }));
      return Promise.resolve({
        status: 'ok',
        sources: mode === 'compact-full' ? sources.slice(0, 4) : sources,
      });
    },
  },
  marketSearch: {
    find: () => {
      marketCalls++;
      return Promise.resolve({
        items: frozen.marketListings ?? [],
        total: frozen.marketListings?.length ?? 0,
        hasNext: false,
      });
    },
    detail: (id: string) => {
      detailCalls++;
      const found = frozen.marketListings?.find((n) => n.id === id);
      if (!found) throw new Error('frozen_detail_missing');
      return Promise.resolve(found);
    },
  },
} as unknown as AgentDeps;
budget.refs.push(ref);
saveBudget();
const started = new Date(),
  before = budget.used;
let outcome: unknown,
  errorKind: string | null = null;
try {
  if (mode === 'full' || mode === 'compact-full') outcome = await runInbound({ deps, ctx, input });
  else {
    Object.assign(ctx, {
      task: { ...prior, id: task.id, ownerUserId: ctx.userId, scope: task.scope },
      currentRequest: frozen.currentRequest,
      knowledgeSources: frozen.knowledgeSources,
      marketListings: frozen.marketListings,
      marketPlan: frozen.marketPlan,
      marketIntent: frozen.marketIntent,
      marketTarget: frozen.marketTarget,
      marketQueries: frozen.marketQueries,
      marketDetailIds: frozen.marketDetailIds,
      informationQueries: frozen.informationQueries,
      taskProgressVersion: frozen.taskProgressVersion,
      isAnswerFinalization: true,
      runDeadlineAt: Date.now() + 45000,
    });
    ctx.deliverySourceRefs = buildDeliveryPacket(ctx).refs;
    if (mode === 'clock-regression') {
      const saved = z
        .object({
          proposals: z
            .array(
              z.object({
                kind: z.enum(['answer', 'partial', 'no_match', 'clarification', 'unavailable']),
                text: z.string(),
                refs: z.array(z.string()),
              }),
            )
            .min(1),
        })
        .parse(
          JSON.parse(readFileSync('logs/p36/replay-family-exhibition-writer-final.json', 'utf8')),
        );
      const args = saved.proposals[0]!;
      const tool = replyToRequestTool(deps);
      const rc = { context: ctx } as never;
      const approval =
        typeof tool.needsApproval === 'function'
          ? await tool.needsApproval(rc, args, 'clock-regression')
          : tool.needsApproval;
      if (approval) throw new Error('unexpected_approval_in_memory_regression');
      const result = await tool.invoke(rc, JSON.stringify(args));
      outcome = { kind: ctx.answerRecorded ? 'recorded' : 'not_recorded', result };
    } else {
      const { agent, runner } = createMatchAgent(deps, {
        phase: 2,
        finalAnswerOnly: true,
        inputRef: ref,
        taskId: ctx.task!.id,
      });
      await runner.run(agent, input, {
        context: ctx,
        maxTurns: 3,
        signal: AbortSignal.timeout(45000),
      });
      outcome = { kind: ctx.answerRecorded ? 'recorded' : 'not_recorded' };
    }
  }
} catch (e) {
  errorKind = e instanceof Error ? e.name : 'unknown';
} finally {
  await processor.forceFlush?.();
  const usage = await repos.traces.summarizeUsage({ since: started, inputRefs: [ref] });
  const report = {
    caseId,
    mode,
    agentVersion: AGENT_VERSION,
    inputFingerprint: createHash('sha256').update(input).digest('hex'),
    inputRef: ref,
    started,
    elapsedMs: Date.now() - started.getTime(),
    boundary:
      'Frozen synthetic task and public tool responses, real runInbound planning/research/delivery and Jev; memory tasks/session/outbox; no live retrieval, no Telegram, not human satisfaction proof.',
    outcome,
    errorKind,
    budgetBlocked,
    used: budget.used - before,
    usage,
    calls,
    proposals,
    informationCalls,
    marketCalls,
    detailCalls,
    gates,
    reply: rows,
    answerRecorded: !!ctx.answerRecorded,
    outboundDeclineReason: ctx.outboundDeclineReason ?? null,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      caseId,
      output,
      used: report.used,
      cumulativeUsed: budget.used,
      informationCalls,
      marketCalls,
      detailCalls,
      replyCount: rows.length,
      deliveryEntered: gates.some((g) => g.gate === 'delivery_stage'),
      errorKind,
    }) + '\n',
  );
  await db.$disconnect();
}
