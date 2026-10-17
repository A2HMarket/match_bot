import { describe, expect, it, vi } from 'vitest';
import { publishApproval } from '../src/publish.js';

const cards = { opsChatId: '-200', defaultPhase: 0 as const };
const runState = {
  id: 'rs1',
  userId: 'owner',
  interruptions: [
    { tool: 'reply_to_request', args: '{"text":"uncompiled"}', draftText: 'frozen preview' },
  ],
} as never;

describe('publishApproval', () => {
  it('queues only the server snapshot identity and fixed destination, without reading a newer unrelated demand', async () => {
    const enqueueApprovalCard = vi.fn().mockResolvedValue({ id: 'outbox' }),
      findOpenByUser = vi.fn().mockRejectedValue(new Error('must not read unrelated requests')),
      repos = { outbound: { enqueueApprovalCard }, demands: { findOpenByUser } };
    await publishApproval({ repos: repos as never, cards, runState });
    expect(enqueueApprovalCard).toHaveBeenCalledWith({
      runStateId: 'rs1',
      opsChatId: '-200',
      defaultPhase: 0,
    });
    expect(findOpenByUser).not.toHaveBeenCalled();
  });
  it('propagates failed durable writes so the pending snapshot can be rediscovered', async () => {
    const enqueueApprovalCard = vi
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue({ id: 'outbox' }),
      repos = { outbound: { enqueueApprovalCard } };
    await expect(publishApproval({ repos: repos as never, cards, runState })).rejects.toThrow(
      'database unavailable',
    );
    await publishApproval({ repos: repos as never, cards, runState });
    expect(enqueueApprovalCard).toHaveBeenCalledTimes(2);
  });
  it('leaves a source paused by policy held rather than sending directly', async () => {
    const enqueueApprovalCard = vi.fn().mockResolvedValue(null);
    await publishApproval({
      repos: { outbound: { enqueueApprovalCard } } as never,
      cards,
      runState,
    });
    expect(enqueueApprovalCard).toHaveBeenCalledOnce();
  });
});
