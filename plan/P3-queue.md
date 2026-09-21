# P3 queue 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 提供四条 BullMQ 队列的创建、入队、消费封装，入队自带幂等 jobId 与 zod 校验。

**Architecture:** `createQueues` 一次创建四个 `Queue`；`enqueue*` 校验载荷后入队；`createWorker` 把 handler 包成先 zod parse 再执行。测试用 docker 的 Redis 跑集成测试。

**Tech Stack:** bullmq 6、ioredis 6、zod 4

**Spec:** `plan/interfaces.md` §queue；`docs/技术架构设计.md` §1 设计原则 3

## Global Constraints

- 只有 `packages/queue` 与 `apps/*` 能 import `bullmq`（AGENTS.md §3.2）。
- 幂等 jobId 用 `inboundJobId`，格式 `channel:chatId:messageId`（AGENTS.md §4.5）。
- 集成测试放 `packages/queue/tests/integration/`，需要 `REDIS_URL`。

---

### Task 1: createQueues / enqueue* / closeQueues

**Files:**
- Create: `packages/queue/src/queues.ts`
- Modify: `packages/queue/src/index.ts`
- Test: `packages/queue/tests/integration/queues.test.ts`

**Interfaces:**
- Produces: `createQueues(redisUrl): Queues`、`enqueueInbound`、`enqueueResume`、`enqueueOutbound`、`closeQueues`

- [x] **Step 1: 写失败测试**

```ts
// packages/queue/tests/integration/queues.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues, createQueues, enqueueInbound, type Queues } from '../../src/queues.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
let q: Queues;
beforeAll(() => { q = createQueues(redisUrl); });
afterAll(async () => { await q.inbound.obliterate({ force: true }); await closeQueues(q); });

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
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm infra:up && pnpm vitest run packages/queue/tests/integration/queues.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/queue/src/queues.ts
import type { InboundMessage } from '@matchbot/domain';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES, inboundJobId, inboundJobSchema, outboundJobSchema, resumeRunJobSchema } from './index.js';

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
```

`packages/queue/src/index.ts` 末尾追加 `export * from './queues.js';`（注意 `queues.ts` 反向 import `index.ts` 的常量会形成循环；把常量与 schema 移到 `packages/queue/src/contracts.ts`，`index.ts` 只 re-export `contracts.js` 与 `queues.js`）。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/queue/tests/integration/queues.test.ts`
Expected: 2 passed

- [x] **Step 5: Commit**

```bash
git add packages/queue
git commit -m "feat(queue): create queues and idempotent enqueue helpers"
```

---

### Task 2: createWorker

**Files:**
- Create: `packages/queue/src/worker.ts`
- Modify: `packages/queue/src/index.ts`
- Test: `packages/queue/tests/integration/worker.test.ts`

**Interfaces:**
- Produces: `createWorker<T>(name, redisUrl, handler, opts?)`，handler 收到已按 schema 校验的 `data` 与 `jobName`（cron 队列靠它分派）

- [x] **Step 1: 写失败测试**

```ts
// packages/queue/tests/integration/worker.test.ts
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
    const w = createWorker<{ outboundMessageId: string }>(QUEUE_NAMES.outbound, redisUrl, async (d) => { got.push(d.outboundMessageId); });
    await enqueueOutbound(q, 'om_1');
    await new Promise((r) => setTimeout(r, 500));
    expect(got).toEqual(['om_1']);
    await w.close();
    await closeQueues(q);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/queue/tests/integration/worker.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/queue/src/worker.ts
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import type { z } from 'zod';
import { QUEUE_NAMES, inboundJobSchema, outboundJobSchema, resumeRunJobSchema } from './contracts.js';

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
const schemas: Record<QueueName, z.ZodTypeAny> = {
  [QUEUE_NAMES.inbound]: inboundJobSchema,
  [QUEUE_NAMES.resume]: resumeRunJobSchema,
  [QUEUE_NAMES.outbound]: outboundJobSchema,
  [QUEUE_NAMES.cron]: inboundJobSchema.partial(), // cron 无载荷；用宽松 schema
};

export function createWorker<T>(name: QueueName, redisUrl: string, handler: (data: T, jobName: string) => Promise<void>, opts: { concurrency?: number } = {}): Worker {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return new Worker(name, async (job) => { await handler(schemas[name].parse(job.data) as T, job.name); }, { connection, concurrency: opts.concurrency ?? 4 });
}
```

`index.ts` 追加 `export * from './worker.js';`

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/queue/tests/integration/worker.test.ts`
Expected: 1 passed

- [x] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/queue
git commit -m "feat(queue): add createWorker with payload validation"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | 完成 |
| 执行者 | kimi |
| PR | `feat/P3-queue`（本地合并，同 P1 先例） |
| 与 interfaces.md 的偏差 | `enqueueOutbound` 的 jobId 直接用 `outboundMessageId`（cuid），不加 `out:` 前缀：bullmq 6.3.8 只允许恰好含两个冒号的自定义 jobId（兼容旧 repeatable job 的临时逻辑，源码注明下个大版本将全禁冒号）。幂等性不变 |
| 备注 | ① 常量与 schema 从 `index.ts` 移到 `contracts.ts` 避免循环 import。② ioredis 6 在 NodeNext 下默认导出不可构造，改用命名导出 `import { Redis } from 'ioredis'`。③ 执行期间主工作区被 P5 agent 切到 `feat/P5-gating`，P3 后半在 `.claude/worktrees/p3-queue` 完成；`feat/P3-queue` 分支指针曾被重置，已通过 ff 恢复。④ `pnpm check` 全绿（34 tests passed）。 |
