/** Isolated PostgreSQL, real SDK, scripted model/Jev, local read-only source and actual SIGKILL. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { z } from 'zod';
import {
  configureModelProvider,
  createTraceProcessor,
  runInbound,
  AGENT_VERSION,
} from '../../../packages/agent/src/index.js';
import { createExecutionProofStore } from '../../../packages/db/tests/integration/execution-proof-store.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { envSchema, createLogger } from '../../../packages/shared/src/index.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';
import { processInbound } from '../../../apps/worker/src/pipeline/inbound.js';

const store = createExecutionProofStore(),
  logger = createLogger('execution-process-proof', 'silent');
const mode = process.argv[2];
if (mode === 'first' || mode === 'recover') {
  const [readyPath, root, inputPath] = process.argv.slice(3);
  if (!root || new URL(root).hostname !== '127.0.0.1') throw new Error('local source required');
  const input = z
    .object({
      channel: z.literal('telegram'),
      chatId: z.string(),
      userId: z.string(),
      messageId: z.string(),
      text: z.string(),
      receivedAt: z.string(),
    })
    .parse(JSON.parse(readFileSync(inputPath!, 'utf8')));
  const env = envSchema.parse({
    DATABASE_URL: 'postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_delivery_proof',
    REDIS_URL: 'redis://127.0.0.1:6379/15',
    DEEPSEEK_API_KEY: 'synthetic',
    JEV_API_KEY: 'synthetic',
    TELEGRAM_BOT_TOKEN: 'synthetic',
    TELEGRAM_OPS_CHAT_ID: '-synthetic',
    SNAPSHOT_KEY: 'execution-proof-secret-key-12345',
  });
  const processor = createTraceProcessor({ traces: store.repos.traces, logger });
  configureModelProvider(env, [processor]);
  const model = new ScriptedModel(
    mode === 'first'
      ? [
          [
            functionCall(
              'start_task',
              {
                objective: '收书桌',
                category: 'second_hand',
                goals: [
                  {
                    id: 'desk',
                    title: '书桌',
                    required: true,
                    sourceQuote: '书桌',
                    criteria: [
                      { id: 'subject', label: '书桌来源', strength: 'hard', constraintKey: null },
                    ],
                  },
                ],
                constraints: [
                  {
                    key: 'area',
                    goalId: null,
                    strength: 'hard',
                    value: { kind: 'location', area: 'E14' },
                    sourceQuote: 'E14',
                  },
                  {
                    key: 'budget',
                    goalId: null,
                    strength: 'hard',
                    value: { kind: 'money', amountPence: 5000, unit: 'item' },
                    sourceQuote: '50镑',
                  },
                ],
              },
              { callId: 'prepare' },
            ),
          ],
          [
            functionCall(
              'market_search',
              {
                intent: 'second_hand',
                purpose: 'discover',
                plan: {
                  needs: [{ id: 'desk', terms: ['书桌', 'desk'] }],
                  preferences: [],
                  requiredTerms: [],
                  excludeTerms: [],
                  requiredArea: ['E14'],
                  budget: 50,
                  route: null,
                  dateRange: null,
                },
                queries: [{ keyword: '书桌', page: 1, tradeType: 'SELL', entity: null }],
              },
              { callId: 'discover' },
            ),
          ],
          [assistantMessage('unreachable')],
        ]
      : [
          [
            functionCall(
              'record_task_progress',
              {
                checks: [
                  {
                    goalId: 'desk',
                    criterionId: 'subject',
                    status: 'supported',
                    sources: [{ ref: 'm1', quote: '出售：书桌' }],
                  },
                  {
                    goalId: 'desk',
                    criterionId: 'condition:budget',
                    status: 'supported',
                    sources: [{ ref: 'm1', quote: null }],
                  },
                  {
                    goalId: 'desk',
                    criterionId: 'condition:area',
                    status: 'supported',
                    sources: [{ ref: 'm1', quote: null }],
                  },
                ],
                next: {
                  action: 'deliver',
                  goalId: 'desk',
                  constraintKey: null,
                  reason: '交付来源与待确认项',
                },
              },
              { callId: 'verify' },
            ),
          ],
          [
            functionCall(
              'reply_to_request',
              {
                kind: 'partial',
                text: '我会先看这张书桌，价格和地点有原文，搬运前请再确认成色。',
                refs: ['m1'],
              },
              { callId: 'reply' },
            ),
          ],
        ],
  );
  const get = model.getResponse.bind(model);
  let calls = 0;
  model.getResponse = async (...args: Parameters<typeof model.getResponse>) => {
    calls++;
    if (mode === 'first' && calls === 3) {
      writeFileSync(readyPath!, JSON.stringify({ pid: process.pid, calls }));
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
    return get(...args);
  };
  const repos = {
    ...store.repos,
    executions: {
      ...store.repos.executions,
      claim: (p: Parameters<typeof store.repos.executions.claim>[0]) =>
        store.repos.executions.claim({ ...p, leaseMs: 2000 }),
    },
  };
  try {
    await processInbound(
      {
        env,
        repos,
        logger,
        thresholds: DEFAULT_THRESHOLDS,
        answerRequests: true,
        taskRequests: true,
        modelProvider: { getModel: () => model },
        runInbound,
        evaluateInbound: async () => ({
          ok: true,
          isDemand: 0.95,
          isSupply: 0.01,
          category: 'second_hand',
          categoryConfidence: 0.95,
          urgency: 1,
          hasLocation: 0.95,
          isSensitive: 0,
          isMoveEvent: 0,
          isLocalRequest: 0.95,
        }),
        jev: {
          evaluate: async (p) => {
            await store.repos.traces.create({
              kind: 'jev',
              inputRef: p.inputRef,
              phase: p.phase,
              latencyMs: 0,
              costMicro: 0,
              output: { synthetic: true },
            });
            return {
              ok: true,
              id: 'synthetic',
              provider: 'synthetic',
              model: 'synthetic',
              usage: { input_tokens: 0, cost: 0 },
              answers: Object.fromEntries(
                Object.keys(p.questions).map((name, index) => {
                  const state = z
                    .object({
                      claims: z.array(z.object({ proposedStatus: z.string() })).optional(),
                    })
                    .passthrough()
                    .parse(p.state);
                  return [
                    name,
                    {
                      type: 'noul',
                      noul: state.claims?.[index]?.proposedStatus === 'conflict' ? 0.01 : 0.95,
                    },
                  ];
                }),
              ),
            };
          },
        },
        evaluateOutbound: async () => {
          throw new Error('shadow must not call outbound judge');
        },
        publishApproval: async () => {
          throw new Error('shadow must not publish approval');
        },
        cards: {} as never,
        marketSearch: {
          find: async () => ({
            items: z
              .array(marketListingSchema)
              .parse(
                await (await fetch(root + '/find', { signal: AbortSignal.timeout(5000) })).json(),
              ),
            hasNext: false,
            total: 1,
          }),
          detail: async () => {
            throw new Error('unrequested detail');
          },
        },
      } as never,
      input,
    );
    await processor.forceFlush();
    process.stdout.write(JSON.stringify({ pid: process.pid, calls }));
  } finally {
    await store.close();
  }
} else {
  const output = process.argv[2] ?? '/tmp/matchbot-execution-process-proof.json',
    dir = mkdtempSync(join(tmpdir(), 'matchbot-execution-proof-'));
  let child: ReturnType<typeof spawn> | undefined,
    queryCount = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/find') {
      response.writeHead(404);
      response.end();
      return;
    }
    queryCount++;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify([
        {
          id: 'desk',
          title: '伦敦E14书桌',
          description: '出售：书桌\n价格：£45\n地点：伦敦E14自提',
          priceLabel: '£45',
          tradeType: 'SELL',
          status: 'ON_SALE',
          tags: [],
          url: 'https://a2hmarket.ai/listings/desk',
          sourceUrl: null,
          isRepost: false,
          availableFrom: null,
          availableUntil: null,
          sourcePublishedAt: null,
          createdAt: null,
        },
      ]),
    );
  });
  const fingerprint = createHash('sha256');
  for (const path of [
    'packages/db/src/repos/executions.ts',
    'packages/db/src/execution-fence.ts',
    'packages/db/src/repos/index.ts',
    'packages/db/src/repos/tasks.ts',
    'packages/domain/src/task-search-terms.ts',
    'packages/agent/src/task-market-plan.ts',
    'packages/agent/src/tools/market-search.ts',
    'packages/db/src/repos/outbound.ts',
    'packages/db/prisma/schema.prisma',
    'packages/agent/src/run.ts',
    'packages/agent/src/execution-checkpoint.ts',
    'apps/worker/src/pipeline/inbound.ts',
    'packages/db/tests/integration/execution-proof-store.ts',
    import.meta.filename,
  ])
    fingerprint.update(relative(process.cwd(), path)).update(readFileSync(path));
  const sourceFingerprint = fingerprint.digest('hex');
  const started = Date.now(),
    watchdog = setTimeout(() => {
      writeFileSync(
        output,
        JSON.stringify({ status: 'timeout', sourceFingerprint, elapsedMs: Date.now() - started }),
      );
      child?.kill('SIGKILL');
      process.exit(2);
    }, 45000);
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  try {
    const seeded = await store.seed(),
      input = {
        channel: 'telegram',
        chatId: seeded.group.externalId,
        userId: seeded.user.externalId,
        messageId: '1',
        text: 'E14想收书桌，50镑以内',
        receivedAt: new Date().toISOString(),
      };
    const inputPath = join(dir, 'input.json'),
      ready = join(dir, 'ready.json');
    writeFileSync(inputPath, JSON.stringify(input));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const root = 'http://127.0.0.1:' + address.port;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', import.meta.filename, 'first', ready, root, inputPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error('first worker did not checkpoint: ' + stderr.slice(-500));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const before = await store.state();
    assert(
      before.message?.executionSnapshot &&
        before.tasks === 1 &&
        before.turnEvents === 1 &&
        queryCount === 1,
      'completed steps not durable',
    );
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, before.message!.user.executionLeaseExpiresAt!.getTime() - Date.now() + 10),
      ),
    );
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', import.meta.filename, 'recover', ready, root, inputPath],
      { timeout: 15000, maxBuffer: 65536 },
    );
    const worker = z
      .object({ pid: z.number(), calls: z.number() })
      .parse(JSON.parse(result.stdout));
    const after = await store.state();
    assert(
      worker.pid !== child.pid && worker.calls === 2,
      'recovery did not use a fresh process or repeated planning',
    );
    assert(
      after.message?.executionStatus === 'completed' && after.message.executionAttempts === 2,
      'execution did not resume to completion',
    );
    assert(
      after.tasks === 1 && after.turnEvents === 1 && queryCount === 1,
      'recovery repeated a completed task step or public query',
    );
    assert(
      after.outbounds.length === 1 && after.outbounds[0]?.status === 'dry_run',
      'recovery did not record exactly one shadow reply',
    );
    assert(!after.message.user.executionLeaseToken, 'user lease was not released');
    const restoredTasks = await store.repos.tasks.findOpenByScope({
      userId: seeded.user.id,
      scope: { channel: 'telegram', chatId: seeded.group.externalId },
    });
    assert(
      restoredTasks[0]?.goals[0]?.searchTerms?.includes('desk'),
      'public search vocabulary was not retained through process recovery',
    );
    writeFileSync(
      output,
      JSON.stringify(
        {
          status: 'passed',
          sourceFingerprint,
          agentVersion: AGENT_VERSION,
          elapsedMs: Date.now() - started,
          boundary:
            'isolated proof database; actual SDK and SIGKILL; scripted model/Jev; one local read-only HTTP source; no Telegram or provider model calls',
          firstPid: child.pid,
          recoveryPid: worker.pid,
          recoveryModelCalls: worker.calls,
          queryCount,
          tasks: after.tasks,
          userTurnEvents: after.turnEvents,
          outbounds: after.outbounds.length,
          executionAttempts: after.message.executionAttempts,
          snapshotEncrypted: !after.message.executionSnapshot?.includes('书桌'),
          searchVocabularyRetained: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    writeFileSync(
      output,
      JSON.stringify(
        {
          status: 'failed',
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : 'unknown',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
    await store.cleanup();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
