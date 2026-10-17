/** Isolated PostgreSQL, actual SDK resume and SIGKILL; no live models or Telegram. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { z } from 'zod';
import {
  runInbound,
  resumeRun,
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  SDK_VERSION,
} from '../../../packages/agent/src/index.js';
import { handleApprovalCallback } from '../../../packages/approval/src/callback.js';
import { processResume } from '../../../apps/worker/src/pipeline/resume.js';
import { publishApproval } from '../../../packages/approval/src/publish.js';
import { dispatchPendingApprovals } from '../../../apps/worker/src/approval-dispatch.js';
import { drainOutbound } from '../../../apps/bot/src/outbound-loop.js';
import { createTelegramSender } from '../../../packages/channel-telegram/src/sender.js';
import { createExecutionProofStore } from '../../../packages/db/tests/integration/execution-proof-store.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import type { ExecutionLease } from '../../../packages/domain/src/index.js';
import type { Repositories } from '../../../packages/db/src/repos/index.js';
import { createLogger, envSchema } from '../../../packages/shared/src/index.js';

const store = createExecutionProofStore(),
  logger = createLogger('approval-proof', 'silent'),
  env = envSchema.parse({
    DATABASE_URL: 'postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_delivery_proof',
    REDIS_URL: 'redis://127.0.0.1:6379/15',
    DEEPSEEK_API_KEY: 'synthetic',
    JEV_API_KEY: 'synthetic',
    TELEGRAM_BOT_TOKEN: 'synthetic',
    TELEGRAM_OPS_CHAT_ID: '-synthetic',
    DEFAULT_PHASE: 1,
    SNAPSHOT_KEY: 'approval-process-proof-key-12345',
  });
const mode = process.argv[2],
  model = new ScriptedModel([[assistantMessage('done')]]),
  processor = createTraceProcessor({ traces: store.repos.traces, logger });
configureModelProvider(env, [processor]);
const deps = {
  env,
  logger,
  repos: store.repos,
  thresholds: DEFAULT_THRESHOLDS,
  answerRequests: true,
  modelProvider: { getModel: () => model },
  jev: {
    evaluate: async () => {
      throw new Error('unexpected Jev');
    },
  },
  evaluateOutbound: async () => {
    throw new Error('phase1 must use approval');
  },
};
if (mode === 'publish') {
  const [inputPath, readyPath] = process.argv.slice(3);
  try {
    const job = z
      .object({ runStateId: z.string() })
      .parse(JSON.parse(readFileSync(inputPath!, 'utf8')));
    const cards = { opsChatId: '-999900000003', defaultPhase: 0 as const };
    if (readyPath)
      await dispatchPendingApprovals({ repos: store.repos, cards, publishApproval, logger });
    else {
      const runState = await store.repos.runStates.findById(job.runStateId);
      if (!runState) throw new Error('missing synthetic snapshot');
      await publishApproval({ repos: store.repos, cards, runState });
    }
    const state = await store.state(),
      card = state.outbounds.find((o) => o.approvalRunStateId === job.runStateId);
    if (!card) throw new Error('card not queued');
    if (readyPath) {
      writeFileSync(readyPath, JSON.stringify({ pid: process.pid, cardId: card.id }));
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
    process.stdout.write(JSON.stringify({ pid: process.pid, cardId: card.id }));
  } finally {
    await store.close();
  }
} else if (mode === 'resume' || mode === 'recover') {
  const [inputPath, readyPath] = process.argv.slice(3),
    job = z
      .object({ runStateId: z.string(), approvalId: z.string() })
      .parse(JSON.parse(readFileSync(inputPath!, 'utf8')));
  let calls = 0;
  const get = model.getResponse.bind(model);
  model.getResponse = async (...args: Parameters<typeof model.getResponse>) => {
    calls++;
    return get(...args);
  };
  const fenced = (lease: ExecutionLease): Repositories => {
    const repos = store.repos.forExecution(lease);
    return {
      ...repos,
      forExecution: fenced,
      outbound: {
        ...repos.outbound,
        create: async (...args: Parameters<typeof repos.outbound.create>) => {
          const row = await repos.outbound.create(...args);
          if (mode === 'resume') {
            writeFileSync(readyPath!, JSON.stringify({ pid: process.pid }));
            await new Promise((resolve) => setTimeout(resolve, 25000));
          }
          return row;
        },
      },
    };
  };
  try {
    await processResume(
      {
        ...deps,
        repos: {
          ...store.repos,
          forExecution: fenced,
          approvals: {
            ...store.repos.approvals,
            claimResume: (p: Parameters<typeof store.repos.approvals.claimResume>[0]) =>
              store.repos.approvals.claimResume({ ...p, leaseMs: 2000 }),
          },
        },
        resumeRun,
        publishApproval: async () => {
          throw new Error('unexpected further interruption');
        },
        cards: {},
      } as never,
      job,
    );
    await processor.forceFlush();
    process.stdout.write(JSON.stringify({ pid: process.pid, modelCalls: calls }));
  } finally {
    await store.close();
  }
} else {
  const output = process.argv[2] ?? '/tmp/matchbot-approval-process-proof.json',
    dir = mkdtempSync(join(tmpdir(), 'matchbot-approval-proof-')),
    started = Date.now();
  let child: ReturnType<typeof spawn> | undefined;
  let apiCalls = 0;
  let expectedCallbacks: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 65536) throw new Error('oversized synthetic request');
      }
      const payload = z
        .object({
          chat_id: z.literal(-999900000003),
          text: z.string(),
          reply_markup: z.object({
            inline_keyboard: z.array(z.array(z.object({ callback_data: z.string() }))),
          }),
        })
        .parse(JSON.parse(body));
      if (
        !payload.text.includes('这次还没找到') ||
        JSON.stringify(payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)) !==
          JSON.stringify(expectedCallbacks)
      )
        throw new Error('incomplete approval card');
      apiCalls++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ message_id: 77, chat: { id: -999900000003 } }));
    })().catch(() => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'invalid synthetic request' }));
    });
  });
  const watchdog = setTimeout(() => {
    child?.kill('SIGKILL');
    process.exit(2);
  }, 45000);
  const assert = (value: unknown, why: string) => {
    if (!value) throw new Error(why);
  };
  const sourceHash = createHash('sha256');
  for (const path of [
    'packages/agent/src/run.ts',
    'packages/db/src/repos/approvals.ts',
    'packages/db/src/repos/executions.ts',
    'packages/db/src/repos/run-states.ts',
    'packages/db/src/repos/outbound.ts',
    'packages/db/src/approval-card-store.ts',
    'packages/domain/src/approval-preview.ts',
    'packages/db/prisma/schema.prisma',
    'packages/db/prisma/migrations/20261016231000_durable_approval_cards/migration.sql',
    'packages/approval/src/callback.ts',
    'packages/approval/src/publish.ts',
    'packages/channel-telegram/src/sender.ts',
    'packages/channel-telegram/src/ops-card.ts',
    'apps/worker/src/pipeline/resume.ts',
    'apps/worker/src/approval-dispatch.ts',
    'apps/bot/src/outbound-loop.ts',
    'packages/db/tests/integration/execution-proof-store.ts',
    import.meta.filename,
  ])
    sourceHash.update(path).update(readFileSync(path));
  const sourceFingerprint = sourceHash.digest('hex');
  try {
    const { user, group } = await store.seed(1),
      { message } = await store.repos.executions.accept({
        userId: user.id,
        groupId: group.id,
        phase: 1,
        message: {
          channel: 'telegram',
          chatId: group.externalId,
          userId: user.externalId,
          messageId: '1',
          text: '找书桌',
          receivedAt: new Date().toISOString(),
        },
      }),
      claim = await store.repos.executions.claim({ userId: user.id, messageId: message.id });
    if (claim.kind !== 'acquired') throw new Error('missing inbound lease');
    const initialModel = new ScriptedModel([
        [
          functionCall(
            'reply_to_request',
            {
              kind: 'no_match',
              text: '这次还没找到可确认的书桌；可以先比较尺寸和自提方式。',
              refs: [],
            },
            { callId: 'approved-original' },
          ),
        ],
      ]),
      initial = await runInbound({
        deps: { ...deps, modelProvider: { getModel: () => initialModel } } as never,
        ctx: {
          userId: user.id,
          channel: 'telegram',
          chatId: group.externalId,
          groupId: group.id,
          sourceMessageId: message.id,
          source: { messageId: '1', userId: user.externalId },
          execution: claim.lease,
          phase: 1,
          recentReplies: [],
        },
        input: message.text,
      });
    if (initial.kind !== 'interrupted') throw new Error('SDK did not suspend');
    expectedCallbacks = ['approve', 'reject', 'ignore'].map(
      (decision) => 'apv:' + initial.runStateId + ':' + decision,
    );
    await store.repos.executions.finish({
      lease: claim.lease,
      status: 'waiting_approval',
      runStateId: initial.runStateId,
    });
    const rollback = await store.probeDecisionRollback(initial.runStateId);
    assert(
      rollback.runState.status === 'pending' && rollback.approvals === 0,
      'consume survived a rolled-back decision',
    );
    assert(
      (
        await store.repos.runStates.pendingCards({
          agentVersion: AGENT_VERSION,
          sdkVersion: SDK_VERSION,
          defaultPhase: 0,
        })
      ).some((rs) => rs.id === initial.runStateId),
      'unpublished snapshot was not rediscovered',
    );
    const cardInput = join(dir, 'card-job.json'),
      cardReady = join(dir, 'card-ready.json');
    writeFileSync(cardInput, JSON.stringify({ runStateId: initial.runStateId }));
    child = spawn(
      process.execPath,
      ['--import', 'tsx', import.meta.filename, 'publish', cardInput, cardReady],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const cardDeadline = Date.now() + 15000;
    while (!existsSync(cardReady)) {
      if (child.exitCode !== null || Date.now() > cardDeadline)
        throw new Error('publisher did not persist card');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const published = z
        .object({ pid: z.number(), cardId: z.string() })
        .parse(JSON.parse(readFileSync(cardReady, 'utf8'))),
      publisherPid = child.pid;
    const duplicate = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', import.meta.filename, 'publish', cardInput],
      { timeout: 15000, maxBuffer: 65536 },
    );
    assert(
      z.object({ cardId: z.string() }).parse(JSON.parse(duplicate.stdout)).cardId ===
        published.cardId,
      'duplicate publisher created another card',
    );
    const publisherExit = once(child, 'exit');
    child.kill('SIGKILL');
    await publisherExit;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local transport');
    const endpoint = 'http://127.0.0.1:' + address.port;
    const sender = createTelegramSender({
      logger,
      bot: {
        api: {
          sendMessage: async (chatId: number, text: string, options: unknown) => {
            const result = await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text, ...(options as object) }),
              signal: AbortSignal.timeout(3000),
            });
            const value: unknown = await result.json();
            return value;
          },
        },
      } as never,
    });
    await drainOutbound({
      repos: store.repos,
      sender,
      logger,
      defaultPhase: 0,
      opsChatId: '-999900000003',
    });
    const deliveredCard = (await store.state()).outbounds.find((o) => o.id === published.cardId);
    assert(
      apiCalls === 1 &&
        deliveredCard?.status === 'sent' &&
        deliveredCard.externalMessageId === '77',
      'card was not delivered once through fenced sender',
    );
    const callback = await handleApprovalCallback({
      repos: store.repos,
      queues: {} as never,
      reviewer: 'synthetic',
      data: 'apv:' + initial.runStateId + ':approve',
      enqueueResume: async () => {
        throw new Error('injected Redis failure');
      },
    });
    const accepted = await store.state(),
      approval = accepted.approvals[0];
    assert(
      callback === 'pending' &&
        approval?.resumeStatus === 'accepted' &&
        accepted.runStates[0]?.status === 'consumed',
      'decision and wake intent lost after transport failure',
    );
    assert(
      (await store.repos.approvals.dispatchable()).some((i) => i.approvalId === approval?.id),
      'missing durable dispatch intent',
    );
    const inputPath = join(dir, 'job.json'),
      ready = join(dir, 'ready.json');
    writeFileSync(
      inputPath,
      JSON.stringify({ runStateId: initial.runStateId, approvalId: approval!.id }),
    );
    child = spawn(
      process.execPath,
      ['--import', 'tsx', import.meta.filename, 'resume', inputPath, ready],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error('resume did not reach checkpoint: ' + stderr.slice(-800));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const queued = await store.state();
    assert(
      queued.outbounds.filter((o) => !o.approvalRunStateId).length === 1 &&
        queued.outbounds.find((o) => !o.approvalRunStateId)?.sourceMessageId === message.id &&
        queued.outbounds.find((o) => !o.approvalRunStateId)?.status === 'pending',
      'approved call not fenced to original request',
    );
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, queued.message!.user.executionLeaseExpiresAt!.getTime() - Date.now() + 10),
      ),
    );
    const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', import.meta.filename, 'recover', inputPath, ready],
        { timeout: 15000, maxBuffer: 65536 },
      ),
      recovered = z.object({ pid: z.number(), modelCalls: z.number() }).parse(JSON.parse(stdout)),
      after = await store.state();
    assert(
      recovered.pid !== child.pid && recovered.modelCalls === 0,
      'already-queued approved action reran the model',
    );
    assert(
      after.outbounds.filter((o) => !o.approvalRunStateId).length === 1 &&
        after.approvals.length === 1 &&
        after.approvals[0]?.resumeStatus === 'completed' &&
        after.message?.executionStatus === 'completed' &&
        !after.message.user.executionLeaseToken,
      'approval recovery did not settle once',
    );
    const redacted = await store.expireSnapshots(),
      retained = await store.state();
    assert(
      redacted === 1 &&
        retained.runStates.every((rs) => rs.snapshot === '' && rs.status === 'expired') &&
        retained.outbounds.find((o) => o.approvalRunStateId)?.text === '[approval content expired]',
      'expired approval contents remained',
    );
    writeFileSync(
      output,
      JSON.stringify(
        {
          status: 'passed',
          agentVersion: AGENT_VERSION,
          sourceFingerprint,
          elapsedMs: Date.now() - started,
          boundary:
            'isolated PostgreSQL; actual SDK suspension/resume, independent publishers and workers, real SIGKILL and lease expiry, fenced sender to local HTTP only; scripted model; no provider or Telegram calls',
          rollback: { runStateStatus: rollback.runState.status, approvalRows: rollback.approvals },
          redisFailure: { callback, durableIntent: true },
          firstPid: child.pid,
          recoveryPid: recovered.pid,
          recoveryModelCalls: recovered.modelCalls,
          outbounds: after.outbounds.filter((o) => !o.approvalRunStateId).length,
          approvalCards: after.outbounds.filter((o) => !!o.approvalRunStateId).length,
          publisherPid,
          approvalApiCalls: apiCalls,
          expiredContentRedacted: redacted,
          approvals: after.approvals.length,
          requestStatus: after.message?.executionStatus,
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
          sourceFingerprint,
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
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
    await store.cleanup();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
