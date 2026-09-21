# P7 channel-telegram 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Telegram 的 Update 规范化成 `InboundMessage`，把 `OutboundMessage` 发出去，并提供审批卡的渲染与回调解析。

**Architecture:** 三个纯函数（`toInboundMessage`、`parseApprovalCallback`、`renderApprovalCard`）加两个薄封装（`createTelegramSender`、`createOpsCardSender`）。grammY 的 `Bot` 实例由 `apps/bot` 创建后注入，本包不持有 token。

**Tech Stack:** grammY 1.46、vitest

**Spec:** `plan/interfaces.md` §channel-telegram；`docs/技术架构设计.md` §8.1、§8.4 线框；PoC V5 结论（chat id 与 from id 的实际形态）

## Global Constraints

- 只有本包能 import `grammy`（AGENTS.md §3.2）。
- 发送只从 `OutboundMessage` 行发；本包不写 `outbound_messages`，也不决定发不发。
- Telegram 的 int64 id 一律转字符串（AGENTS.md §4.1）。
- 出站文本末尾固定免责一句（PRD §6.3），由 P8 的工具在写出站表时加，本包不重复加。

---

### Task 1: toInboundMessage

**Files:**
- Create: `packages/channel-telegram/src/inbound.ts`
- Create: `packages/channel-telegram/tests/fixtures/update-group-text.json`、`update-private-text.json`、`update-photo.json`
- Modify: `packages/channel-telegram/src/index.ts`
- Test: `packages/channel-telegram/tests/inbound.test.ts`

- [ ] **Step 1: fixture 与失败测试**

`tests/fixtures/update-group-text.json`（按 PoC V5 抓到的真实形状调整字段值）：

```json
{ "update_id": 1, "message": { "message_id": 55, "date": 1758800000, "chat": { "id": -1001234567890, "type": "supergroup", "title": "LONDON CITY" }, "from": { "id": 987654321, "is_bot": false, "first_name": "Anna", "language_code": "en" }, "text": "I need someone with a van this Sunday, moving from E14 to SE1", "reply_to_message": { "message_id": 50, "date": 1758799000, "chat": { "id": -1001234567890, "type": "supergroup", "title": "LONDON CITY" }, "text": "x" } } }
```

`update-private-text.json`：同上但 `chat: { id: 987654321, type: "private", first_name: "Anna" }`，无 `reply_to_message`。
`update-photo.json`：`message` 里没有 `text`，有 `photo: [...]`。

```ts
// packages/channel-telegram/tests/inbound.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toInboundMessage } from '../src/inbound.js';

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));

describe('toInboundMessage', () => {
  it('maps a group text message', () => {
    const m = toInboundMessage(load('update-group-text'), { botId: 111 });
    expect(m).toEqual({
      channel: 'telegram', chatId: '-1001234567890', messageId: '55', userId: '987654321',
      text: 'I need someone with a van this Sunday, moving from E14 to SE1', lang: 'en', replyToMessageId: '50', receivedAt: '2025-09-25T12:13:20.000Z',
    });
  });
  it('maps a private message without replyTo', () => {
    const m = toInboundMessage(load('update-private-text'), { botId: 111 });
    expect(m?.chatId).toBe('987654321');
    expect(m?.replyToMessageId).toBeUndefined();
  });
  it('returns null for non-text and for the bot itself', () => {
    expect(toInboundMessage(load('update-photo'), { botId: 111 })).toBeNull();
    const own = load('update-group-text');
    own.message.from.id = 111;
    expect(toInboundMessage(own, { botId: 111 })).toBeNull();
  });
});
```

（`receivedAt` 期望值按 fixture 的 `date` 换算；`1758800000` → `2025-09-25T12:13:20.000Z`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/channel-telegram/tests/inbound.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/channel-telegram/src/inbound.ts
import { inboundMessageSchema, type InboundMessage } from '@matchbot/domain';
import type { Update } from 'grammy/types';

/** 只接受文本消息；图片、贴纸、服务消息、Bot 自己的消息返回 null。渠道差异到此为止。 */
export function toInboundMessage(update: Update, p: { botId: number }): InboundMessage | null {
  const m = update.message;
  if (!m || typeof m.text !== 'string' || !m.from || m.from.is_bot || m.from.id === p.botId) return null;
  if (m.chat.type !== 'private' && m.chat.type !== 'group' && m.chat.type !== 'supergroup') return null;
  const lang = m.from.language_code?.slice(0, 2);
  return inboundMessageSchema.parse({
    channel: 'telegram',
    chatId: String(m.chat.id),
    messageId: String(m.message_id),
    userId: String(m.from.id),
    text: m.text,
    ...(lang ? { lang } : {}),
    ...(m.reply_to_message ? { replyToMessageId: String(m.reply_to_message.message_id) } : {}),
    receivedAt: new Date(m.date * 1000).toISOString(),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/channel-telegram/tests/inbound.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/channel-telegram
git commit -m "feat(channel-telegram): normalize updates to InboundMessage"
```

---

### Task 2: createTelegramSender

**Files:**
- Create: `packages/channel-telegram/src/sender.ts`
- Modify: `packages/channel-telegram/src/index.ts`
- Test: `packages/channel-telegram/tests/sender.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/channel-telegram/tests/sender.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createTelegramSender, TelegramSendError } from '../src/sender.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const msg = { id: 'om1', channel: 'telegram', target: '-100', text: 'hi', status: 'pending', toolCallId: null, error: null, createdAt: new Date(), sentAt: null } as never;

describe('createTelegramSender', () => {
  it('calls bot.api.sendMessage with numeric chat id and disabled link preview', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    await createTelegramSender({ bot: { api: { sendMessage } } as never, logger }).send(msg);
    expect(sendMessage).toHaveBeenCalledWith(-100, 'hi', expect.objectContaining({ link_preview_options: { is_disabled: true } }));
  });
  it('wraps api errors', async () => {
    const sendMessage = vi.fn(async () => { throw new Error('403: bot was kicked'); });
    await expect(createTelegramSender({ bot: { api: { sendMessage } } as never, logger }).send(msg)).rejects.toBeInstanceOf(TelegramSendError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/channel-telegram/tests/sender.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/channel-telegram/src/sender.ts
import type { OutboundMessage } from '@matchbot/db';
import type { Logger } from '@matchbot/shared';
import type { Bot } from 'grammy';

export class TelegramSendError extends Error {
  constructor(readonly outboundMessageId: string, cause: unknown) {
    super(`telegram send failed for ${outboundMessageId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TelegramSendError';
  }
}

export function createTelegramSender(p: { bot: Bot; logger: Logger }) {
  return {
    async send(m: OutboundMessage): Promise<void> {
      try {
        await p.bot.api.sendMessage(Number(m.target), m.text, { link_preview_options: { is_disabled: true } });
        p.logger.info({ outboundMessageId: m.id, target: m.target }, 'sent');
      } catch (e) {
        throw new TelegramSendError(m.id, e);
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/channel-telegram/tests/sender.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add packages/channel-telegram
git commit -m "feat(channel-telegram): outbound sender"
```

---

### Task 3: 审批卡渲染、发送与回调解析

**Files:**
- Create: `packages/channel-telegram/src/ops-card.ts`
- Modify: `packages/channel-telegram/src/index.ts`
- Test: `packages/channel-telegram/tests/ops-card.test.ts`

**Interfaces:**
- Produces: `ApprovalCard`、`renderApprovalCard(card): { text: string; keyboard: InlineKeyboard }`、`createOpsCardSender`、`parseApprovalCallback`

- [ ] **Step 1: 写失败测试**

```ts
// packages/channel-telegram/tests/ops-card.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createOpsCardSender, parseApprovalCallback, renderApprovalCard } from '../src/ops-card.js';

const card = { runStateId: 'rs_1', title: 'Man & Van · LONDON CITY · 0.94', draftText: '@Anna 3 options...', supplierLines: ['1. Van Co £40/h', '2. Move Ltd £55/h'], confidence: 0.94 };

describe('renderApprovalCard', () => {
  it('includes title, draft, suppliers and three buttons', () => {
    const { text, keyboard } = renderApprovalCard(card);
    expect(text).toContain('Man & Van');
    expect(text).toContain('@Anna 3 options');
    expect(text).toContain('2. Move Ltd');
    const datas = keyboard.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(datas).toEqual(['apv:rs_1:approve', 'apv:rs_1:reject', 'apv:rs_1:ignore']);
  });
});

describe('parseApprovalCallback', () => {
  it.each([
    ['apv:rs_1:approve', { runStateId: 'rs_1', decision: 'approve' }],
    ['apv:rs_1:reject', { runStateId: 'rs_1', decision: 'reject' }],
    ['apv:rs_1:edit', null],
    ['xyz', null],
  ])('%s', (data, expected) => {
    expect(parseApprovalCallback(data)).toEqual(expected);
  });
});

describe('createOpsCardSender', () => {
  it('sends to ops chat and returns message id', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 77 }));
    const r = await createOpsCardSender({ bot: { api: { sendMessage } } as never, opsChatId: '-200' }).sendApprovalCard(card);
    expect(r).toEqual({ messageId: '77' });
    expect(sendMessage).toHaveBeenCalledWith(-200, expect.any(String), expect.objectContaining({ reply_markup: expect.anything() }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/channel-telegram/tests/ops-card.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/channel-telegram/src/ops-card.ts
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

export interface ApprovalCard { runStateId: string; title: string; draftText: string; supplierLines: string[]; confidence: number }
const DECISIONS = ['approve', 'reject', 'ignore'] as const;
type Decision = (typeof DECISIONS)[number];

/** Phase 1 审批台就是运营群里的一张卡（架构 §8.4）。「改文案」走人工旁路，不做按钮。 */
export function renderApprovalCard(c: ApprovalCard): { text: string; keyboard: InlineKeyboard } {
  const text = [`🔎 ${c.title}`, '', '拟发：', c.draftText, '', '候选：', ...c.supplierLines, '', `置信度 ${c.confidence.toFixed(2)}`].join('\n');
  const keyboard = new InlineKeyboard()
    .text('✅ 批准', `apv:${c.runStateId}:approve`)
    .text('❌ 拒绝', `apv:${c.runStateId}:reject`)
    .text('⏭ 忽略', `apv:${c.runStateId}:ignore`);
  return { text, keyboard };
}

export function createOpsCardSender(p: { bot: Bot; opsChatId: string }) {
  return {
    async sendApprovalCard(card: ApprovalCard): Promise<{ messageId: string }> {
      const { text, keyboard } = renderApprovalCard(card);
      const r = await p.bot.api.sendMessage(Number(p.opsChatId), text, { reply_markup: keyboard });
      return { messageId: String(r.message_id) };
    },
  };
}

export function parseApprovalCallback(data: string): { runStateId: string; decision: Decision } | null {
  const m = /^apv:([A-Za-z0-9_-]+):(approve|reject|ignore)$/.exec(data);
  if (!m?.[1] || !m[2]) return null;
  return { runStateId: m[1], decision: m[2] as Decision };
}
```

`index.ts` re-export `inbound.js`、`sender.js`、`ops-card.js`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/channel-telegram/tests/ops-card.test.ts`
Expected: 6 passed

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/channel-telegram
git commit -m "feat(channel-telegram): approval card rendering and callback parsing"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | 完成 |
| 执行者 | claude (subagent-driven-development) |
| PR | `feat/P7-channel-telegram`（本地合并） |
| 与 interfaces.md 的偏差 | 无实质偏差；仅发现 interfaces.md 对 `toInboundMessage` 签名的记录过时（缺 `p: { botId }` 参数），已回写修正。 |
| 备注 | 3 tasks 完成，pnpm check 全绿（12 files / 42 tests）。发现的非阻塞 minor 已记录在 SDD ledger，留给 P9/P10 跟进：ops-card.ts 未包裹发送错误（不像 sender.ts 有 TelegramSendError）；`Number(target)`/`Number(opsChatId)` 非数字输入会得到 NaN；inbound.ts 对 schema 校验失败会 throw 而非返回 null；缺少部分测试边界 fixture（带 caption 的图片、其他 bot 消息、无 language_code）。 |
