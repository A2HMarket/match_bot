import { describe, expect, it, vi } from 'vitest';
import { dispatchAcceptedInbound } from '../src/inbound-dispatch.js';
describe('durable inbound dispatch', () => {
  it('does not acknowledge dispatch before Redis accepts the job', async () => {
    const item = {
      userId: 'user',
      messageId: 'stored',
      recoverActive: false,
      message: {
        channel: 'telegram',
        chatId: '-1',
        userId: '42',
        messageId: '1',
        text: '找桌子',
        receivedAt: new Date().toISOString(),
      },
    };
    const markEnqueued = vi.fn(),
      enqueue = vi
        .fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValue(undefined);
    const repos = { executions: { dispatchable: () => Promise.resolve([item]), markEnqueued } };
    const p = {
      repos: repos as never,
      queues: {} as never,
      enqueue,
      logger: { warn: vi.fn() } as never,
    };
    await dispatchAcceptedInbound(p);
    expect(markEnqueued).not.toHaveBeenCalled();
    await dispatchAcceptedInbound(p);
    expect(markEnqueued).toHaveBeenCalledWith({ userId: 'user', messageId: 'stored' });
  });
});
