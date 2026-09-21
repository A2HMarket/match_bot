import type { InboundMessage } from '@matchbot/domain';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES, inboundJobId, inboundJobSchema, outboundJobSchema, resumeRunJobSchema } from './contracts.js';

export interface Queues {
  connection: IORedis;
  inbound: Queue;
  resume: Queue;
  outbound: Queue;
  cron: Queue;
}

const defaultJobOptions = { attempts: 3, backoff: { type: 'exponential' as const, delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 };

export function createQueues(redisUrl: string): Queues {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const mk = (name: string) => new Queue(name, { connection, defaultJobOptions });
  return { connection, inbound: mk(QUEUE_NAMES.inbound), resume: mk(QUEUE_NAMES.resume), outbound: mk(QUEUE_NAMES.outbound), cron: mk(QUEUE_NAMES.cron) };
}

export async function enqueueInbound(q: Queues, msg: InboundMessage): Promise<void> {
  const data = inboundJobSchema.parse(msg);
  await q.inbound.add('inbound', data, { jobId: inboundJobId(data.channel, data.chatId, data.messageId) });
}

export async function enqueueResume(q: Queues, p: { runStateId: string; approvalId: string }): Promise<void> {
  const data = resumeRunJobSchema.parse(p);
  await q.resume.add('resume', data, { jobId: `resume:${data.runStateId}:${data.approvalId}` });
}

export async function enqueueOutbound(q: Queues, outboundMessageId: string): Promise<void> {
  const data = outboundJobSchema.parse({ outboundMessageId });
  await q.outbound.add('outbound', data, { jobId: `out:${outboundMessageId}` });
}

export async function closeQueues(q: Queues): Promise<void> {
  await Promise.all([q.inbound.close(), q.resume.close(), q.outbound.close(), q.cron.close()]);
  await q.connection.quit();
}
