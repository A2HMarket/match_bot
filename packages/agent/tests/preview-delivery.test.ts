import { afterEach, expect, it, vi } from 'vitest';
import { waitForPreviewOutbounds } from '../../../scripts/poc/p27-task-agent/preview-delivery.mjs';
afterEach(() => vi.useRealTimers());
it('waits for an already claimed simulated send to persist its actual receipt before grading', async () => {
  vi.useFakeTimers();
  const findMany = vi
    .fn()
    .mockResolvedValueOnce([{ status: 'sending', externalMessageId: null }])
    .mockResolvedValue([{ status: 'sent', externalMessageId: '1001' }]);
  const pending = waitForPreviewOutbounds({
    prisma: { outboundMessage: { findMany } } as never,
    sourceMessageId: 'synthetic',
    timeoutMs: 100,
  });
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toEqual([{ status: 'sent', externalMessageId: '1001' }]);
});
it('preserves an unconfirmed claim at the deadline instead of inventing a sent receipt', async () => {
  vi.useFakeTimers();
  const findMany = vi.fn().mockResolvedValue([{ status: 'sending', externalMessageId: null }]);
  const pending = waitForPreviewOutbounds({
    prisma: { outboundMessage: { findMany } } as never,
    sourceMessageId: 'synthetic',
    timeoutMs: 40,
  });
  await vi.advanceTimersByTimeAsync(60);
  expect(await pending).toEqual([{ status: 'sending', externalMessageId: null }]);
});
