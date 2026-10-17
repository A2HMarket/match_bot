import { describe, expect, it, vi } from 'vitest';
import { TelegramSendError } from '@matchbot/channel-telegram';
import { drainOutbound } from '../src/outbound-loop.js';

function setup() {
  const rows = [
    { id: 'a', phase: 2, channel: 'telegram', target: '-1', text: 'x', leaseToken: 'fence-a' },
    { id: 'b', phase: 2, channel: 'telegram', target: '-1', text: 'y', leaseToken: 'fence-b' },
  ];
  const outbound = {
    claimPending: vi
      .fn()
      .mockResolvedValueOnce([rows[0]])
      .mockResolvedValueOnce([rows[1]])
      .mockResolvedValue([]),
    recoverExpiredClaims: vi.fn().mockResolvedValue({ requeued: 0, unknown: 0, failed: 0 }),
    beginSend: vi.fn().mockResolvedValue(true),
    markSent: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
  };
  const groups = { findByExternal: vi.fn().mockResolvedValue({ phase: 2, isActive: true }) };
  const dispatch = vi.fn((id: string) =>
    Promise.resolve({ kind: 'message' as const, externalMessageId: id === 'a' ? '1' : '2' }),
  );
  const sender = {
    send: vi.fn(async (row: { id: string }, p?: { beforeSend: () => Promise<boolean> }) =>
      p && !(await p.beforeSend()) ? { kind: 'not_started' as const } : dispatch(row.id),
    ),
  };
  return {
    outbound,
    groups,
    sender,
    dispatch,
    p: {
      repos: { outbound, groups } as never,
      sender,
      defaultPhase: 2 as const,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
    },
  };
}
describe('drainOutbound', () => {
  it('delivers control cards only to the current fixed ops destination while source checks stay in beginSend', async () => {
    const { p, outbound, groups, dispatch } = setup(),
      row = {
        id: 'card',
        phase: 1,
        channel: 'telegram',
        target: '-200',
        text: 'frozen preview',
        leaseToken: 'card-fence',
        approvalRunStateId: 'rs',
        requestKey: 'approval:rs',
      };
    outbound.claimPending.mockReset().mockResolvedValueOnce([row]).mockResolvedValue([]);
    groups.findByExternal.mockResolvedValue({ phase: 0, isActive: true });
    await drainOutbound({ ...p, opsChatId: '-200', defaultPhase: 0 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(outbound.beginSend).toHaveBeenCalledWith({
      id: 'card',
      leaseToken: 'card-fence',
      opsChatId: '-200',
      defaultPhase: 0,
    });
    outbound.claimPending.mockResolvedValueOnce([row]).mockResolvedValue([]);
    dispatch.mockClear();
    await drainOutbound({ ...p, opsChatId: '-201', defaultPhase: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('records real receipts and distinguishes transport uncertainty from a known rejection', async () => {
    const { p, outbound, dispatch } = setup();
    dispatch.mockRejectedValueOnce(new TelegramSendError('a', new Error('network')));
    await drainOutbound(p);
    expect(outbound.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'a',
        leaseToken: 'fence-a',
        deliveryState: 'unknown',
        errorCode: 'network_error',
      }),
    );
    expect(outbound.markSent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b', leaseToken: 'fence-b', externalMessageId: '2' }),
    );
  });
  it('does not turn a receipt database failure into a failed-send retry', async () => {
    const { p, outbound } = setup();
    outbound.markSent.mockRejectedValueOnce(new Error('db unavailable'));
    await drainOutbound(p);
    expect(outbound.markFailed).not.toHaveBeenCalled();
  });
  it('does not dispatch after a lost fence or a switch to Phase 0', async () => {
    const { p, outbound, dispatch, groups } = setup();
    outbound.beginSend.mockResolvedValueOnce(false);
    groups.findByExternal
      .mockResolvedValueOnce({ phase: 2, isActive: true })
      .mockResolvedValue({ phase: 0, isActive: true });
    await drainOutbound(p);
    expect(dispatch).not.toHaveBeenCalled();
    expect(outbound.markSent).not.toHaveBeenCalled();
  });
  it('reschedules only a definitive rate-limit rejection', async () => {
    const { p, outbound, dispatch } = setup();
    dispatch.mockRejectedValueOnce(
      new TelegramSendError('a', null, {
        deliveryState: 'not_sent',
        errorCode: 'telegram_429',
        retryAfterSeconds: 2,
      }),
    );
    await drainOutbound(p);
    const failed = outbound.markFailed.mock.calls[0]?.[0] as {
      retryAt: Date;
      deliveryState: string;
    };
    expect(failed.deliveryState).toBe('not_sent');
    expect(failed.retryAt.getTime()).toBeGreaterThan(Date.now());
  });
});
