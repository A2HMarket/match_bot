import { replyRequestStatusTool } from './tools/reply-request-status.js';
import { bindCurrentRequest } from './current-request.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Approval, RunState } from '@matchbot/db';
import type { DemandDraft, Phase } from '@matchbot/domain';
import { resolveTaskMarketTarget } from './task-market-plan.js';
import { decrypt, encrypt } from '@matchbot/shared';
import { RunContext, RunState as SdkRunState } from '@openai/agents';
import { z } from 'zod';
import { AGENT_VERSION, createMatchAgent } from './agent.js';
import type { AgentDeps, MatchContext } from './context.js';
import { createPgSession } from './session.js';
import { restoreSearchContext } from './restore-search-context.js';
import { prepareTaskTurn } from './task-preparation.js';
import { restoreExecutionCheckpoint } from './execution-checkpoint.js';

export type RunOutcome =
  { kind: 'completed'; toolsCalled: string[] } | { kind: 'interrupted'; runStateId: string };

const SNAPSHOT_TTL_DAYS = 7; // AGENTS.md §6：7 天后标 expired
const MAX_TURNS = 12; // P14：需求建档 + 分主题召回 + 展名补全 + 一次回复，仍有固定上限

/** 从 @openai/agents 的 package.json 读版本，避免手写漂移；读不到就标 unknown。 */
function resolveSdkVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('@openai/agents');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
const SDK_VERSION = resolveSdkVersion();

const RUN_OPTIONS = { maxTurns: MAX_TURNS } as const;
const RUN_TIMEOUT_MS = 150000;

export async function runInbound(p: {
  deps: AgentDeps;
  ctx: MatchContext;
  input: string;
  checkpoint?: string | null;
}): Promise<RunOutcome> {
  if (p.ctx.execution) {
    if (
      p.ctx.execution.userId !== p.ctx.userId ||
      p.ctx.execution.messageId !== p.ctx.sourceMessageId
    )
      throw new Error('execution context identity mismatch');
    p = { ...p, deps: { ...p.deps, repos: p.deps.repos.forExecution(p.ctx.execution) } };
  }
  p.ctx.runDeadlineAt = Date.now() + RUN_TIMEOUT_MS;
  const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const session = createPgSession({
    repos: p.deps.repos,
    userId: p.ctx.userId,
    isolatePreviousTurns: !!p.deps.answerRequests,
  });
  const recovery = p.ctx.execution
    ? await p.deps.repos.executions.recoveryFlags(p.ctx.execution)
    : null;
  if (p.deps.taskRequests) {
    if (!p.deps.answerRequests) throw new Error('taskRequests requires answerRequests');
    bindCurrentRequest(p.ctx, p.input);
    if (!(await prepareTaskTurn({ ...p, signal }))) {
      if (p.ctx.currentRequest && (p.ctx.addressedToBot || p.ctx.taskCandidates?.length))
        p.ctx.currentRequest.isActionable = true;
      return respondRequestStatus(p, session);
    }
  }
  if (p.deps.answerRequests) {
    bindCurrentRequest(p.ctx, p.input);
    if (p.checkpoint && p.ctx.execution) {
      try {
        Object.assign(
          p.ctx,
          restoreExecutionCheckpoint(p.deps, p.ctx, p.input, p.checkpoint, AGENT_VERSION),
        );
        const restoredDemandId = p.ctx.demandId;
        bindCurrentRequest(p.ctx, p.input);
        if (restoredDemandId) p.ctx.demandId = restoredDemandId;
      } catch (error) {
        await p.deps.repos.traces.create({
          kind: 'gate',
          inputRef: p.ctx.sourceMessageId,
          phase: p.ctx.phase,
          latencyMs: 0,
          costMicro: 0,
          output: {
            gate: 'execution_checkpoint',
            decision: 'discarded',
            errorKind: error instanceof Error ? error.name : 'unknown',
          },
        });
      }
    }
    if (recovery?.outboundBlocked) p.ctx.outboundBlocked = true;
    if (recovery?.answerInputExhausted) p.ctx.answerInputExhausted = true;
    if (
      p.ctx.currentRequest &&
      (p.ctx.taskUpdate?.kind === 'ambiguous' || p.ctx.taskUpdate?.kind === 'unbound')
    )
      p.ctx.currentRequest.isActionable = true;
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: {
        gate: 'current_request',
        category: p.ctx.currentRequest?.demand.category,
        ...(p.ctx.task
          ? {
              taskId: p.ctx.task.id,
              taskRevision: p.ctx.task.revision,
              requirementsVersion: p.ctx.task.requirementsVersion,
            }
          : {}),
      },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
  }
  if (recovery?.outboundBlocked || recovery?.answerInputExhausted)
    return respondRequestStatus(p, session);
  if (p.deps.marketSearch) {
    p.ctx.marketTarget = resolveTaskMarketTarget(p.ctx.task, p.input);
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: { gate: 'market_trade_direction', target: p.ctx.marketTarget },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
  }
  const ambiguous = p.ctx.taskUpdate?.kind === 'ambiguous' || p.ctx.taskUpdate?.kind === 'unbound';
  const { agent, runner } = createMatchAgent(p.deps, {
    phase: p.ctx.phase,
    input: p.ctx.currentRequest?.text ?? p.input,
    checkpointInput: p.input,
    finalAnswerOnly: ambiguous,
    inputRef: p.ctx.sourceMessageId,
    ...(p.ctx.task ? { taskId: p.ctx.task.id } : {}),
  });
  let result: SettleResult;
  try {
    result = await runner.run(agent, p.input, { context: p.ctx, session, ...RUN_OPTIONS, signal });
  } catch (error) {
    if (!p.deps.answerRequests || !(error instanceof Error) || /Guardrail/.test(error.name))
      throw error;
    p.ctx.sourceFailures ??= [];
    p.ctx.sourceFailures.push('processing:' + error.name);
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: { gate: 'answer_finalization', reason: error.name },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
    return respondRequestStatus(p, session);
  }
  if (
    p.deps.answerRequests &&
    result.interruptions.some((item) => !hasValidArguments(item.arguments))
  ) {
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: { gate: 'answer_finalization', reason: 'malformed_tool_json' },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
    p.ctx.sourceFailures ??= [];
    p.ctx.sourceFailures.push('processing:invalid_tool_input');
    return finalizeRequest(p, session);
  }
  if (
    p.deps.answerRequests &&
    !result.interruptions.length &&
    !p.ctx.answerRecorded &&
    p.ctx.currentRequest?.isActionable &&
    p.ctx.currentRequest.demand.category !== 'job'
  )
    return p.ctx.outboundBlocked || p.ctx.answerInputExhausted
      ? respondRequestStatus(p, session)
      : finalizeRequest(p, session);
  return settle(p.deps, p.ctx, result);
}

function hasValidArguments(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return z.record(z.string(), z.unknown()).safeParse(JSON.parse(raw) as unknown).success;
  } catch {
    return false;
  }
}

async function finalizeRequest(
  p: { deps: AgentDeps; ctx: MatchContext; input: string },
  session: ReturnType<typeof createPgSession>,
): Promise<RunOutcome> {
  const remaining = (p.ctx.runDeadlineAt ?? Date.now() + 30000) - Date.now();
  if (remaining <= 0) return respondRequestStatus(p, session);
  p.ctx.isAnswerFinalization = true;
  if (p.ctx.answerInputExhausted) {
    p.ctx.sourceFailures ??= [];
    p.ctx.sourceFailures.push('processing:invalid_evidence');
  }
  const { agent, runner } = createMatchAgent(p.deps, {
    phase: p.ctx.phase,
    input: p.input,
    finalAnswerOnly: true,
  });
  try {
    const result = await runner.run(agent, p.input, {
      context: p.ctx,
      session,
      maxTurns: 3,
      signal: AbortSignal.timeout(Math.min(30000, remaining)),
    });
    if (result.interruptions.some((item) => !hasValidArguments(item.arguments)))
      return respondRequestStatus(p, session);
    if (!result.interruptions.length && !p.ctx.answerRecorded)
      return respondRequestStatus(p, session);
    return settle(p.deps, p.ctx, result);
  } catch (error) {
    if (!(error instanceof Error) || /Guardrail/.test(error.name)) throw error;
    return respondRequestStatus(p, session);
  }
}

async function respondRequestStatus(
  p: { deps: AgentDeps; ctx: MatchContext; input: string },
  session: ReturnType<typeof createPgSession>,
): Promise<RunOutcome> {
  if (
    !p.ctx.currentRequest?.isActionable ||
    p.ctx.currentRequest.demand.category === 'job' ||
    p.ctx.answerRecorded
  )
    return { kind: 'completed', toolsCalled: [] };
  p.ctx.isRequestStatusRun = true;
  await p.deps.repos.traces.create({
    kind: 'gate',
    inputRef: p.ctx.sourceMessageId,
    phase: p.ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'request_status',
      reason:
        p.ctx.outboundDeclineReason ??
        (p.ctx.answerInputExhausted ? 'invalid_evidence' : 'no_answer'),
    },
  });
  const status = replyRequestStatusTool(p.deps);
  const context = new RunContext(p.ctx);
  // No generation model is needed for a fixed acknowledgement. Approval-required phases still use the SDK snapshot path.
  if (!(await status.needsApproval(context, {}, 'request-status:' + p.ctx.sourceMessageId))) {
    await status.invoke(context, '{}');
    return { kind: 'completed', toolsCalled: ['reply_request_status'] };
  }
  const { agent, runner } = createMatchAgent(p.deps, {
    phase: p.ctx.phase,
    input: p.input,
    requestStatusOnly: true,
  });
  const result = await runner.run(agent, 'Call reply_request_status with {} exactly once.', {
    context: p.ctx,
    session,
    maxTurns: 2,
    signal: AbortSignal.timeout(30000),
  });
  return settle(p.deps, p.ctx, result);
}

/**
 * 审批恢复入口。快照只从服务端存储来（AGENTS.md §3.3 第 6 条）；重复消费由
 * repos.runStates.consume 在上游原子拒绝，这里假定拿到的 runState 已被独占。
 * PoC V2：批准一次 ≠ 跑完——若恢复后仍有中断，settle 会再写一行 pending run_state。
 */
export async function resumeRun(p: {
  deps: AgentDeps;
  runState: RunState;
  approval: Approval;
}): Promise<RunOutcome> {
  const snapshot = decrypt(p.runState.snapshot, snapshotKey(p.deps));
  const ctx = restoreSearchContext(await rebuildContext(p.deps, p.runState), snapshot);
  const { agent, runner } = createMatchAgent(p.deps, {
    phase: ctx.phase,
    requestStatusOnly: !!ctx.isRequestStatusRun,
  });
  // PoC V2：用 fromStringWithContext 才能还原自己的 RunContext
  const state = await SdkRunState.fromStringWithContext(agent, snapshot, new RunContext(ctx));
  for (const item of state.getInterruptions()) {
    if (p.approval.decision === 'approve') {
      state.approve(item);
    } else {
      // 「改文案」Phase 1 由运营旁路发送（架构 §4.3 第 5 条），这里只终止原调用
      const message =
        p.approval.decision === 'ignore'
          ? 'Ops decided not to reply this time.'
          : p.approval.decision === 'edit'
            ? 'Ops sent an edited version manually. Do not retry this outbound action.'
            : 'Ops rejected this reply.';
      state.reject(item, { message });
    }
  }
  const session = createPgSession({ repos: p.deps.repos, userId: ctx.userId });
  const result = await runner.run(agent, state, { session, ...RUN_OPTIONS });
  return settle(p.deps, ctx, result);
}

function snapshotKey(deps: AgentDeps): string {
  const key = deps.env.SNAPSHOT_KEY;
  if (!key) throw new Error('SNAPSHOT_KEY is required to persist/resume run_states snapshots');
  return key;
}

/** run_states 只存 userId/chatId/phase；其余上下文恢复时重建：开放需求从库里取最新一条。 */
async function rebuildContext(deps: AgentDeps, runState: RunState): Promise<MatchContext> {
  const [open] = await deps.repos.demands.findOpenByUser(runState.userId);
  // Prisma 列是 Int，这里收窄回 Phase；脏数据按 Phase 0（最保守）处理
  const phase: Phase = runState.phase === 1 || runState.phase === 2 ? runState.phase : 0;
  if (!open) {
    return {
      userId: runState.userId,
      chatId: runState.chatId,
      groupId: null,
      phase,
      sourceMessageId: runState.id,
      recentReplies: [],
    };
  }
  const demand: DemandDraft = {
    category: open.category,
    confidence: open.confidence,
    ...(open.whenText ? { whenText: open.whenText } : {}),
    ...(open.whenAt ? { whenAt: open.whenAt.toISOString() } : {}),
    ...(open.fromPostcode ? { fromPostcode: open.fromPostcode } : {}),
    ...(open.toPostcode ? { toPostcode: open.toPostcode } : {}),
    ...(open.quantity ? { quantity: open.quantity } : {}),
    ...(open.budgetPence !== null ? { budgetPence: open.budgetPence } : {}),
    ...(open.lang ? { lang: open.lang } : {}),
  };
  return {
    userId: runState.userId,
    chatId: runState.chatId,
    groupId: null,
    phase,
    sourceMessageId: runState.id,
    recentReplies: [],
    demand,
    demandId: open.id,
  };
}

interface SettleResult {
  interruptions: Array<{
    name?: string | undefined;
    arguments?: string | undefined;
    rawItem?: unknown;
  }>;
  state: { toString(): string };
  newItems: Array<{ type: string; rawItem: unknown }>;
}

async function settle(
  deps: AgentDeps,
  ctx: MatchContext,
  result: SettleResult,
): Promise<RunOutcome> {
  if (result.interruptions.length > 0) {
    const row = await deps.repos.runStates.create({
      userId: ctx.userId,
      chatId: ctx.chatId,
      phase: ctx.phase,
      ...(ctx.execution ? { messageId: ctx.execution.messageId } : {}),
      snapshot: encrypt(result.state.toString(), snapshotKey(deps)),
      agentVersion: AGENT_VERSION,
      sdkVersion: SDK_VERSION,
      interruptions: result.interruptions.map((i) => {
        const parsed = z.object({ callId: z.string() }).safeParse(i.rawItem);
        const draftText = parsed.success ? ctx.outboundPreviews?.[parsed.data.callId] : undefined;
        return {
          tool: i.name ?? 'unknown',
          args: i.arguments ?? '',
          ...(draftText ? { draftText } : {}),
        };
      }),
      expiresAt: new Date(Date.now() + SNAPSHOT_TTL_DAYS * 86400e3),
    });
    return { kind: 'interrupted', runStateId: row.id };
  }
  const toolsCalled = result.newItems
    .filter((i) => i.type === 'tool_call_item')
    .map((i) => (i.rawItem as { name?: string }).name ?? 'unknown');
  return { kind: 'completed', toolsCalled };
}
