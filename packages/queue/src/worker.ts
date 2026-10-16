import { Worker, DelayedError } from 'bullmq';
import { Redis } from 'ioredis';
import type { z } from 'zod';
import {
  QUEUE_NAMES,
  inboundJobSchema,
  outboundJobSchema,
  resumeRunJobSchema,
} from './contracts.js';

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
const schemas: Record<QueueName, z.ZodTypeAny> = {
  [QUEUE_NAMES.inbound]: inboundJobSchema,
  [QUEUE_NAMES.resume]: resumeRunJobSchema,
  [QUEUE_NAMES.outbound]: outboundJobSchema,
  [QUEUE_NAMES.cron]: inboundJobSchema.partial(), // cron 无载荷；用宽松 schema
};

export function createWorker<T>(
  name: QueueName,
  redisUrl: string,
  handler: (data: T, jobName: string) => Promise<void | { deferMs: number }>,
  opts: { concurrency?: number } = {},
): Worker {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return new Worker(
    name,
    async (job, token) => {
      const result = await handler(schemas[name].parse(job.data) as T, job.name);
      if (result) {
        const delay = result.deferMs;
        if (!Number.isInteger(delay) || delay < 100 || delay > 60000)
          throw new Error('invalid worker defer duration');
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
    },
    { connection, concurrency: opts.concurrency ?? 4 },
  );
}
