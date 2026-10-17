import { afterEach, expect, it, vi } from 'vitest';
import {
  waitForPreviewOutbounds,
  previewExternalMessageId,
} from '../../../scripts/poc/p27-task-agent/preview-delivery.mjs';
afterEach(() => vi.useRealTimers());
it('assigns distinct stable numeric server receipts even when separate clients start with the same local counter', () => {
  const first = previewExternalMessageId('outbound-a'),
    second = previewExternalMessageId('outbound-b');
  expect(first).not.toBe(second);
  expect(previewExternalMessageId('outbound-a')).toBe(first);
  expect(BigInt(first)).toBeGreaterThan(0n);
  expect(BigInt(first)).toBeLessThan(2n ** 63n);
});
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
