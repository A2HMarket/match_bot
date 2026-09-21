import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues, createQueues, enqueueInbound, type Queues } from '../../src/queues.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
let q: Queues;
beforeAll(() => {
  q = createQueues(redisUrl);
});
afterAll(async () => {
  await q.inbound.obliterate({ force: true });
  await closeQueues(q);
});

const msg = { channel: 'telegram' as const, chatId: '-100', messageId: '1', userId: '42', text: 'hi', receivedAt: new Date().toISOString() };

describe('enqueueInbound', () => {
  it('dedupes by jobId', async () => {
    await q.inbound.obliterate({ force: true });
    await enqueueInbound(q, msg);
    await enqueueInbound(q, msg);
    expect(await q.inbound.getWaitingCount()).toBe(1);
  });
  it('rejects invalid payload before touching redis', async () => {
    await expect(enqueueInbound(q, { ...msg, receivedAt: 'yesterday' })).rejects.toThrow();
  });
});
