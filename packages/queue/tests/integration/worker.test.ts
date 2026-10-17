import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../../src/contracts.js';
import { closeQueues, createQueues, enqueueOutbound } from '../../src/queues.js';
import { createWorker } from '../../src/worker.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// 固定用 15 号库：本机部署的 bot/worker 用 0 号库，测试里的 obliterate 会清空整条队列，
// 共用一个库时跑一次 pnpm check 就会吞掉线上还没处理的群消息。
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

describe('createWorker', () => {
  it('releases the Redis connection it owns when the worker closes', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../fixtures/worker-close.ts', import.meta.url)),
        redisUrl,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const result: unknown = await once(child, 'close');
      const [code, signal] = z
        .tuple([z.number().int().nullable(), z.string().nullable()])
        .parse(result);
      expect(output).toContain('worker closed');
      expect(signal, 'closed worker must exit naturally, not retain a Redis socket').toBeNull();
      expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 10000);
  it('defers routine lease contention without spending failed attempts', async () => {
    const q = createQueues(redisUrl);
    await q.outbound.obliterate({ force: true });
    let calls = 0,
      failures = 0;
    const w = createWorker<{ outboundMessageId: string }>(QUEUE_NAMES.outbound, redisUrl, () =>
      Promise.resolve(++calls === 1 ? { deferMs: 100 } : undefined),
    );
    w.on('failed', () => {
      failures++;
    });
    try {
      await enqueueOutbound(q, 'deferred-fixture');
      const deadline = Date.now() + 4000;
      while (
        Date.now() < deadline &&
        (await q.outbound.getJob('deferred-fixture'))?.finishedOn === undefined
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      const job = await q.outbound.getJob('deferred-fixture');
      expect(await job?.getState()).toBe('completed');
      expect(job?.attemptsMade).toBe(1);
      expect(calls).toBe(2);
      expect(failures).toBe(0);
    } finally {
      await w.close();
      await closeQueues(q);
    }
  });
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
