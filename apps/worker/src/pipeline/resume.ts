import type { AgentDeps, resumeRun as resumeRunFn } from '@matchbot/agent';
import type { publishApproval as publishApprovalFn } from '@matchbot/approval';
import type { Phase } from '@matchbot/domain';

export interface ResumeDeps extends AgentDeps {
  resumeRun: typeof resumeRunFn;
  publishApproval: typeof publishApprovalFn;
  cards: Parameters<typeof publishApprovalFn>[0]['cards'];
}

function toPhase(raw: number): Phase {
  return raw === 1 || raw === 2 ? raw : 0;
}

/**
 * 消费 resume_run job。快照的原子消费已由 approval 的回调 (`runStates.consume`) 完成，
 * 这里只按 id 取回（AGENTS.md §3.3 第 6 条）。上下文由 `resumeRun` 从 run_states 自己重建
 * （userId / chatId / phase 都在行上），worker 不再拼 MatchContext。
 * PoC V2 ②：批准一次 ≠ 跑完——恢复后若再次中断，settle 会新写一行 pending，这里要再发一张卡。
 */
export async function processResume(
  d: ResumeDeps,
  job: { runStateId: string; approvalId: string },
): Promise<void> {
  const t0 = Date.now();
  const runState = await d.repos.runStates.findById(job.runStateId);
  const approval = await d.repos.approvals.findById(job.approvalId);
  if (!runState || !approval) {
    d.logger.warn(job, 'resume: missing run state or approval');
    return;
  }

  const phase = toPhase(runState.phase);
  const r = await d.resumeRun({ deps: d, runState, approval });
  const output: Record<string, unknown> =
    r.kind === 'completed'
      ? { outcome: 'resume_completed', toolsCalled: r.toolsCalled }
      : { outcome: 'resume_interrupted', runStateId: r.runStateId };

  if (r.kind === 'interrupted') {
    const next = await d.repos.runStates.findById(r.runStateId);
    if (next) {
      await d.publishApproval({ repos: d.repos, cards: d.cards, runState: next });
    } else {
      d.logger.warn({ runStateId: r.runStateId }, 'resume: interrupted run has no run_state row');
    }
  }

  await d.repos.traces.create({
    kind: 'gate',
    inputRef: runState.id,
    output: { ...output, decision: approval.decision },
    phase,
    latencyMs: Date.now() - t0,
    costMicro: 0,
  });
}
