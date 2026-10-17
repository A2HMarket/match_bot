import { expect, it, vi } from 'vitest';
import { dispatchPendingApprovals } from '../src/approval-dispatch.js';
it('rediscovers an unsent approval after its first publisher fails without rerunning the agent', async () => {
  const runState = { id: 'snapshot' },
    pendingCards = vi.fn().mockResolvedValue([runState]),
    publishApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined),
    repos = { runStates: { pendingCards } },
    cards = { opsChatId: '-200', defaultPhase: 0 as const },
    p = { repos: repos as never, cards, publishApproval, logger: { warn: vi.fn() } as never };
  await dispatchPendingApprovals(p);
  await dispatchPendingApprovals(p);
  expect(publishApproval).toHaveBeenCalledTimes(2);
  expect(publishApproval).toHaveBeenLastCalledWith({ repos, cards, runState });
  expect(pendingCards).toHaveBeenCalledWith(expect.objectContaining({ defaultPhase: 0 }));
});
