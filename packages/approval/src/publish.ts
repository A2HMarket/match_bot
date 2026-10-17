import type { Repositories, RunState } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';

export type ApprovalDestination = { opsChatId: string; defaultPhase: Phase };

/** 把中断快照渲染成运营群审批卡（架构 §4.3，Phase 1 审批台即运营群）。 */
export async function publishApproval(p: {
  repos: Repositories;
  cards: ApprovalDestination;
  runState: RunState;
}): Promise<void> {
  await p.repos.outbound.enqueueApprovalCard({
    runStateId: p.runState.id,
    opsChatId: p.cards.opsChatId,
    defaultPhase: p.cards.defaultPhase,
  });
}
