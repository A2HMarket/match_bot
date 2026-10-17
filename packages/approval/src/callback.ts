import { parseApprovalCallback } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import { enqueueResume as defaultEnqueueResume, type Queues } from '@matchbot/queue';

/** Commit the decision and wake intent together; failed Redis transport remains dispatchable. */
export async function handleApprovalCallback(p: {
  repos: Repositories;
  queues: Queues;
  reviewer: string;
  data: string;
  enqueueResume?: typeof defaultEnqueueResume;
}): Promise<'queued' | 'pending' | 'ignored' | 'invalid'> {
  const parsed = parseApprovalCallback(p.data);
  if (!parsed) return 'invalid';
  const approval = await p.repos.approvals.decide({
    runStateId: parsed.runStateId,
    reviewer: p.reviewer,
    decision: parsed.decision,
  });
  if (!approval) return 'ignored';
  if (parsed.decision === 'ignore') return 'ignored';
  const job = { runStateId: parsed.runStateId, approvalId: approval.id };
  try {
    await (p.enqueueResume ?? defaultEnqueueResume)(p.queues, job);
    await p.repos.approvals.markEnqueued(job);
  } catch {
    // The authoritative decision already exists. Do not discard it or ask for a second approval.
    return 'pending';
  }
  return 'queued';
}
