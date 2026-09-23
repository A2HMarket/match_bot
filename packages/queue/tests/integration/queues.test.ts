import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues, createQueues, enqueueInbound, type Queues } from '../../src/queues.js';

// 固定用 15 号库：本机部署的 bot/worker 用 0 号库，测试里的 obliterate 会清空整条队列，
// 共用一个库时跑一次 pnpm check 就会吞掉线上还没处理的群消息。
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
let q: Queues;
beforeAll(() => {
  q = createQueues(redisUrl);
});
afterAll(async () => {
  await q.inbound.obliterate({ force: true });
  await closeQueues(q);
});

const msg = {
  channel: 'telegram' as const,
  chatId: '-100',
  messageId: '1',
  userId: '42',
  text: 'hi',
  receivedAt: new Date().toISOString(),
};

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
