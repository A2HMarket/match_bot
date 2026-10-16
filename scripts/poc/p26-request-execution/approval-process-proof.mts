/** Isolated PostgreSQL, actual SDK resume and SIGKILL; no live models or Telegram. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
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
} from '../../../packages/agent/src/index.js';
import { handleApprovalCallback } from '../../../packages/approval/src/callback.js';
import { processResume } from '../../../apps/worker/src/pipeline/resume.js';
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
if (mode === 'resume' || mode === 'recover') {
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
    'packages/approval/src/callback.ts',
    'apps/worker/src/pipeline/resume.ts',
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
      queued.outbounds.length === 1 &&
        queued.outbounds[0]?.sourceMessageId === message.id &&
        queued.outbounds[0]?.status === 'pending',
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
      after.outbounds.length === 1 &&
        after.approvals.length === 1 &&
        after.approvals[0]?.resumeStatus === 'completed' &&
        after.message?.executionStatus === 'completed' &&
        !after.message.user.executionLeaseToken,
      'approval recovery did not settle once',
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
            'isolated PostgreSQL; actual SDK suspension/resume, independent process, real SIGKILL and lease expiry; scripted model; no provider or Telegram calls',
          rollback: { runStateStatus: rollback.runState.status, approvalRows: rollback.approvals },
          redisFailure: { callback, durableIntent: true },
          firstPid: child.pid,
          recoveryPid: recovered.pid,
          recoveryModelCalls: recovered.modelCalls,
          outbounds: after.outbounds.length,
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
    await store.cleanup();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
