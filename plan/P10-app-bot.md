# P10 apps/bot 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** grammY 进程：收群消息入队、消费出站表发送、接运营群审批回调。

**Architecture:** `main.ts` 只做装配；`inbound.ts` 是 grammY middleware（Update → InboundMessage → enqueue）；`outbound-loop.ts` 每 2 秒 `claimPending` 并发送；`callbacks.ts` 处理 `callback_query`。发送与回调只依赖 packages 暴露的函数。

**Tech Stack:** grammY（经 `@matchbot/channel-telegram`）、BullMQ（经 `@matchbot/queue`）

**Spec:** `docs/技术架构设计.md` §1、§2；PoC V5 结论

## Global Constraints

- `apps/bot` 不直接 import `grammy` 的发送 API 以外的东西；`Bot` 实例在这里创建但发送必须经 `createTelegramSender`。
- 只消费 `outbound_messages.status = pending`；`dry_run` 永不发送（AGENTS.md §3.3 第 4 条）。
- 群未在 `groups` 表且 `isActive` 的消息不入队（群管理员未许可不接，PRD §6.2）。首次见到的群写一行 `isActive=false` 待运营开启。

---

### Task 1: inbound middleware

**Files:**
- Create: `apps/bot/src/inbound.ts`
- Test: `apps/bot/tests/inbound.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/bot/tests/inbound.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createInboundHandler } from '../src/inbound.js';

const update = { update_id: 1, message: { message_id: 5, date: 1758800000, chat: { id: -100, type: 'supergroup', title: 'G' }, from: { id: 42, is_bot: false, first_name: 'A' }, text: 'need a van' } } as never;
function deps(group: unknown) {
  return { botId: 1, repos: { groups: { findByExternal: vi.fn(async () => group), upsert: vi.fn(async () => ({ id: 'g', isActive: false })) } }, queues: {}, enqueueInbound: vi.fn(async () => {}), logger: { info: vi.fn(), warn: vi.fn() } } as never;
}
describe('createInboundHandler', () => {
  it('enqueues when group is active', async () => {
    const d = deps({ id: 'g', isActive: true });
    await createInboundHandler(d)(update);
    expect((d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound).toHaveBeenCalledWith({}, expect.objectContaining({ chatId: '-100', text: 'need a van' }));
  });
  it('registers unknown group as inactive and does not enqueue', async () => {
    const d = deps(null);
    await createInboundHandler(d)(update);
    expect((d as { repos: { groups: { upsert: ReturnType<typeof vi.fn> } } }).repos.groups.upsert).toHaveBeenCalledWith({ channel: 'telegram', externalId: '-100', name: 'G' });
    expect((d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound).not.toHaveBeenCalled();
  });
  it('private chats always enqueue', async () => {
    const d = deps(null);
    const priv = { ...update, message: { ...update.message, chat: { id: 42, type: 'private', first_name: 'A' } } } as never;
    await createInboundHandler(d)(priv);
    expect((d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/bot/tests/inbound.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// apps/bot/src/inbound.ts
import { toInboundMessage } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import { enqueueInbound as defaultEnqueue, type Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';
import type { Update } from 'grammy/types';

export function createInboundHandler(p: { botId: number; repos: Repositories; queues: Queues; logger: Logger; enqueueInbound?: typeof defaultEnqueue }) {
  const enqueue = p.enqueueInbound ?? defaultEnqueue;
  return async (update: Update): Promise<void> => {
    const msg = toInboundMessage(update, { botId: p.botId });
    if (!msg) return;
    const isPrivate = update.message?.chat.type === 'private';
    if (!isPrivate) {
      const group = await p.repos.groups.findByExternal('telegram', msg.chatId);
      if (!group) {
        const title = update.message?.chat && 'title' in update.message.chat ? update.message.chat.title : msg.chatId;
        await p.repos.groups.upsert({ channel: 'telegram', externalId: msg.chatId, name: title ?? msg.chatId });
        p.logger.info({ chatId: msg.chatId }, 'new group seen; inactive until ops enables');
        return;
      }
      if (!group.isActive) return;
    }
    await enqueue(p.queues, msg);
  };
}
```

`grammy/types` 的 import 在 apps 里允许（类型），`check-deps` 只查 package.json 依赖；apps/bot 的依赖表已含 channel-telegram，需再加 `grammy` 到 apps/bot 的 dependencies 并把 `EXTERNAL_OWNERS.grammy` 加上 `@matchbot/bot`（本包创建 `Bot` 实例）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/bot/tests/inbound.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add apps/bot scripts/check-deps.mjs
git commit -m "feat(bot): inbound middleware with group gating"
```

---

### Task 2: outbound loop 与 callback 处理

**Files:**
- Create: `apps/bot/src/outbound-loop.ts`、`apps/bot/src/callbacks.ts`
- Test: `apps/bot/tests/outbound-loop.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/bot/tests/outbound-loop.test.ts
import { describe, expect, it, vi } from 'vitest';
import { drainOutbound } from '../src/outbound-loop.js';

describe('drainOutbound', () => {
  it('sends each pending row and marks sent/failed', async () => {
    const rows = [{ id: 'a', target: '-1', text: 'x' }, { id: 'b', target: '-1', text: 'y' }];
    const outbound = { claimPending: vi.fn(async () => rows), markSent: vi.fn(async () => {}), markFailed: vi.fn(async () => {}) };
    const sender = { send: vi.fn(async (m: { id: string }) => { if (m.id === 'b') throw new Error('kicked'); }) };
    await drainOutbound({ repos: { outbound } as never, sender: sender as never, logger: { error: vi.fn() } as never });
    expect(outbound.markSent).toHaveBeenCalledWith('a');
    expect(outbound.markFailed).toHaveBeenCalledWith('b', expect.stringContaining('kicked'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/bot/tests/outbound-loop.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// apps/bot/src/outbound-loop.ts
import type { createTelegramSender } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import type { Logger } from '@matchbot/shared';

export async function drainOutbound(p: { repos: Repositories; sender: ReturnType<typeof createTelegramSender>; logger: Logger }): Promise<void> {
  for (const m of await p.repos.outbound.claimPending(20)) {
    try {
      await p.sender.send(m);
      await p.repos.outbound.markSent(m.id);
    } catch (e) {
      await p.repos.outbound.markFailed(m.id, e instanceof Error ? e.message : String(e));
      p.logger.error({ outboundMessageId: m.id }, 'send failed');
    }
  }
}

export function startOutboundLoop(p: Parameters<typeof drainOutbound>[0] & { intervalMs?: number }): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void drainOutbound(p).finally(() => { running = false; });
  }, p.intervalMs ?? 2000);
  return () => clearInterval(timer);
}
```

```ts
// apps/bot/src/callbacks.ts
import { handleApprovalCallback } from '@matchbot/approval';
import type { Repositories } from '@matchbot/db';
import type { Queues } from '@matchbot/queue';
import type { Bot } from 'grammy';

/** 只接受来自运营群的回调；审批人 = callback 的 from.id。 */
export function registerApprovalCallbacks(p: { bot: Bot; repos: Repositories; queues: Queues; opsChatId: string }): void {
  p.bot.on('callback_query:data', async (ctx) => {
    if (String(ctx.callbackQuery.message?.chat.id) !== p.opsChatId) { await ctx.answerCallbackQuery({ text: 'not allowed' }); return; }
    const r = await handleApprovalCallback({ repos: p.repos, queues: p.queues, reviewer: String(ctx.from.id), data: ctx.callbackQuery.data });
    await ctx.answerCallbackQuery({ text: r === 'queued' ? '已入队' : r === 'ignored' ? '已处理或已过期' : '无效' });
    if (r !== 'invalid') await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/bot/tests/outbound-loop.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): outbound drain loop and approval callbacks"
```

---

### Task 3: main.ts 装配与本地冒烟

**Files:**
- Modify: `apps/bot/src/main.ts`

- [ ] **Step 1: 装配**

```ts
// apps/bot/src/main.ts
import { createOpsCardSender, createTelegramSender } from '@matchbot/channel-telegram';
import { createRepositories, disconnectPrisma, getPrisma } from '@matchbot/db';
import { closeQueues, createQueues } from '@matchbot/queue';
import { createLogger, loadEnv } from '@matchbot/shared';
import { Bot } from 'grammy';
import { registerApprovalCallbacks } from './callbacks.js';
import { createInboundHandler } from './inbound.js';
import { startOutboundLoop } from './outbound-loop.js';

const env = loadEnv();
const log = createLogger('bot', env.LOG_LEVEL);
const repos = createRepositories(getPrisma(env.DATABASE_URL));
const queues = createQueues(env.REDIS_URL);
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
const me = await bot.api.getMe();

const inbound = createInboundHandler({ botId: me.id, repos, queues, logger: log });
bot.on('message:text', (ctx) => inbound(ctx.update));
registerApprovalCallbacks({ bot, repos, queues, opsChatId: env.TELEGRAM_OPS_CHAT_ID });
const stopLoop = startOutboundLoop({ repos, sender: createTelegramSender({ bot, logger: log }), logger: log });
void createOpsCardSender; // 供 worker 使用的 sender 在 worker 进程里创建，这里只保留 import 校验

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { stopLoop(); void bot.stop(); void closeQueues(queues); void disconnectPrisma(); });
}
log.info({ botId: me.id, phase: env.DEFAULT_PHASE }, 'bot started');
await bot.start();
```

删掉那行 `void createOpsCardSender`，改为不 import 它。

- [ ] **Step 2: 本地冒烟**

Run: `pnpm infra:up && pnpm db:migrate && pnpm dev:bot`
手动：在测试群发一条文本；用 `pnpm --filter @matchbot/db studio` 看 `groups` 出现一行 `isActive=false`；把它改 true 再发一条；`redis-cli llen bull:inbound_message:wait` 或 BullMQ UI 看到 job。
Expected: 群自动登记；开启后消息入队。

- [ ] **Step 3: 全量检查并提交**

Run: `pnpm check`

```bash
git add apps/bot
git commit -m "feat(bot): wire main process"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | |
| 执行者 | |
| PR | |
| 冒烟结果 | |
| 备注 | |
