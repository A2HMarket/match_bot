import { describe, expect, it, vi } from 'vitest';
import { handleApprovalCallback } from '../src/callback.js';

function deps(consumeResult: unknown) {
  return {
    repos: {
      approvals: {
        decide: vi.fn().mockResolvedValue(consumeResult ? { id: 'ap1' } : null),
        markEnqueued: vi.fn(),
      },
    },
    queues: {},
    enqueueResume: vi.fn().mockResolvedValue(undefined),
  };
}

describe('handleApprovalCallback', () => {
  it('approve: consumes, records, enqueues', async () => {
    const d = deps({ id: 'rs1' });
    expect(
      await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:approve' } as never),
    ).toBe('queued');
    expect(d.repos.approvals.decide).toHaveBeenCalledWith({
      runStateId: 'rs1',
      reviewer: '555',
      decision: 'approve',
    });
    expect(d.enqueueResume).toHaveBeenCalledWith({}, { runStateId: 'rs1', approvalId: 'ap1' });
  });

  it('reject: also resumes so the model gets rejection feedback', async () => {
    const d = deps({ id: 'rs1' });
    expect(
      await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:reject' } as never),
    ).toBe('queued');
    expect(d.repos.approvals.decide).toHaveBeenCalledWith({
      runStateId: 'rs1',
      reviewer: '555',
      decision: 'reject',
    });
    expect(d.enqueueResume).toHaveBeenCalledWith({}, { runStateId: 'rs1', approvalId: 'ap1' });
  });

  it('ignore: consumes and records, does not enqueue', async () => {
    const d = deps({ id: 'rs1' });
    expect(
      await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:ignore' } as never),
    ).toBe('ignored');
    expect(d.enqueueResume).not.toHaveBeenCalled();
  });

  it('already consumed -> ignored without writing', async () => {
    const d = deps(null);
    expect(
      await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:approve' } as never),
    ).toBe('ignored');
    expect(d.enqueueResume).not.toHaveBeenCalled();
  });

  it('garbage -> invalid', async () => {
    expect(
      await handleApprovalCallback({ ...deps(null), reviewer: '555', data: 'nope' } as never),
    ).toBe('invalid');
  });
  it('preserves a committed decision when Redis rejects enqueue, without marking dispatch', async () => {
    const d = deps({ id: 'rs1' });
    d.enqueueResume.mockRejectedValueOnce(new Error('redis unavailable'));
    expect(
      await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:approve' } as never),
    ).toBe('pending');
    expect(d.repos.approvals.decide).toHaveBeenCalledOnce();
    expect(d.repos.approvals.markEnqueued).not.toHaveBeenCalled();
  });
});
