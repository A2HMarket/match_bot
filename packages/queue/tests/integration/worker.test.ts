import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../../src/contracts.js';
import { closeQueues, createQueues, enqueueOutbound } from '../../src/queues.js';
import { createWorker } from '../../src/worker.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('createWorker', () => {
  it('delivers a validated payload to the handler', async () => {
    const q = createQueues(redisUrl);
    await q.outbound.obliterate({ force: true });
    const got: string[] = [];
    const w = createWorker<{ outboundMessageId: string }>(QUEUE_NAMES.outbound, redisUrl, (d) => {
      got.push(d.outboundMessageId);
      return Promise.resolve();
    });
    await enqueueOutbound(q, 'om_1');
    await new Promise((r) => setTimeout(r, 500));
    expect(got).toEqual(['om_1']);
    await w.close();
    await closeQueues(q);
  });
});
