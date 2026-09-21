import { parseApprovalCallback } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import { enqueueResume as defaultEnqueueResume, type Queues } from '@matchbot/queue';

/** 原子消费快照后才写审批与入队（AGENTS.md §3.3 第 6 条）。reject 也要恢复 run，让模型收到拒绝反馈并结束。 */
export async function handleApprovalCallback(p: {
  repos: Repositories;
  queues: Queues;
  reviewer: string;
  data: string;
  enqueueResume?: typeof defaultEnqueueResume;
}): Promise<'queued' | 'ignored' | 'invalid'> {
  const parsed = parseApprovalCallback(p.data);
  if (!parsed) return 'invalid';
  const rs = await p.repos.runStates.consume(parsed.runStateId);
  if (!rs) return 'ignored';
  const approval = await p.repos.approvals.create({
    runStateId: rs.id,
    reviewer: p.reviewer,
    decision: parsed.decision,
  });
  if (parsed.decision === 'ignore') return 'ignored';
  await (p.enqueueResume ?? defaultEnqueueResume)(p.queues, {
    runStateId: rs.id,
    approvalId: approval.id,
  });
  return 'queued';
}
