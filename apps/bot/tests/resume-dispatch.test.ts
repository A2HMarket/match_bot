import { describe, expect, it, vi } from 'vitest';
import { dispatchApprovedResumes } from '../src/resume-dispatch.js';
describe('durable approved resume dispatch', () => {
  it('retries a committed wake intent after transport fails, acknowledging only successful dispatch', async () => {
    const item = { runStateId: 'run', approvalId: 'approval', recoverActive: true },
      markEnqueued = vi.fn(),
      enqueue = vi
        .fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValue(undefined),
      repos = { approvals: { dispatchable: () => Promise.resolve([item]), markEnqueued } },
      p = {
        repos: repos as never,
        queues: {} as never,
        enqueue,
        logger: { warn: vi.fn() } as never,
      };
    await dispatchApprovedResumes(p);
    expect(markEnqueued).not.toHaveBeenCalled();
    await dispatchApprovedResumes(p);
    expect(markEnqueued).toHaveBeenCalledWith({ runStateId: 'run', approvalId: 'approval' });
    expect(enqueue).toHaveBeenLastCalledWith(
      {},
      { runStateId: 'run', approvalId: 'approval' },
      { recoverActive: true },
    );
  });
});
