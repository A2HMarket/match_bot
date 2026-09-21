# P0 PoC 六项验证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在写 `packages/agent` 之前，用最小脚本验证六个架构假设，把结论回写到 `scripts/poc/README.md` 与本文件。

**Architecture:** 每个 PoC 一个独立目录 `scripts/poc/vN-<name>/`，只依赖根 `node_modules`，用 `tsx` 直接跑；不进 packages，不要求过 lint。六项互相独立，可分给六个 agent 并行。

**Tech Stack:** `@openai/agents` 0.18、`openai` 7、zod 4、`tsx`、grammY、pg

**Spec:** `docs/技术架构设计.md` §11

## Global Constraints

- 需要真实密钥：`DEEPSEEK_API_KEY`（V1、V2、V3、V6）、`JEV_API_KEY`（V4）、`TELEGRAM_BOT_TOKEN`（V5）。从根 `.env` 读取，脚本里用 `process.env` 是允许的（AGENTS.md §3.3 第 8 条对 `scripts/` 不适用）。
- PoC 脚本不得 import `packages/*`。
- 每个 PoC 的结论必须写成"通过 / 未通过 + 证据 + 对 P8 的影响"三段，回写两处：`scripts/poc/README.md` 表格、本文件末尾"完成记录"。
- 根 `package.json` 需要临时把 `@openai/agents`、`openai`、`grammy`、`pg` 加进 devDependencies 才能在 scripts 里 import；PoC 完成后保留（后续 packages 也用），但**不要**在 `scripts/` 之外 import 它们。

---

### Task 1: V1 deepseek-flash 经 Chat Completions 的多工具调用

**Files:**
- Create: `scripts/poc/v1-deepseek-tools/main.ts`
- Create: `scripts/poc/v1-deepseek-tools/samples.json`
- Modify: `package.json`（devDependencies 加 `"@openai/agents": "^0.18.0"`, `"openai": "^7.2.0"`）

**Interfaces:**
- Produces: 结论"`OpenAIProvider({ baseURL, useResponses: false })` + `model: 'deepseek-flash'` 是否能稳定调用 zod 参数工具"

- [ ] **Step 1: 准备 10 条样例**

`samples.json`：

```json
[
  { "text": "I need someone with a van this Sunday, moving from E14 to SE1, around 8 boxes", "expectTool": "upsert_demand", "expectCategory": "man_and_van" },
  { "text": "退租要做 end of tenancy cleaning，1-bed，下周三，SW6", "expectTool": "upsert_demand", "expectCategory": "eot_cleaning" },
  { "text": "Кто может собрать шкаф IKEA PAX в субботу? N1", "expectTool": "upsert_demand", "expectCategory": "furniture_service" },
  { "text": "Tenho uma van livre no domingo, posso ajudar com mudanças na zona leste", "expectTool": "upsert_supply", "expectCategory": "man_and_van" },
  { "text": "有人周末有 van 吗，我可以出车帮忙搬，东伦敦", "expectTool": "upsert_supply", "expectCategory": "man_and_van" },
  { "text": "Looking for a room near Stratford from 1 March", "expectTool": "do_nothing", "expectCategory": "housing" },
  { "text": "哈哈哈今天好累", "expectTool": "do_nothing", "expectCategory": "other" },
  { "text": "Need a man and van, 2 bed flat, from Ilford to Croydon, next Friday, budget £150", "expectTool": "upsert_demand", "expectCategory": "man_and_van" },
  { "text": "Anyone knows a cleaner for end of tenancy? 2 bed, E1", "expectTool": "upsert_demand", "expectCategory": "eot_cleaning" },
  { "text": "Selling a double bed frame £40 pick up only SE15", "expectTool": "do_nothing", "expectCategory": "second_hand" }
]
```

- [ ] **Step 2: 写脚本**

```ts
// scripts/poc/v1-deepseek-tools/main.ts
import { Agent, OpenAIProvider, run, setDefaultModelProvider, setTracingDisabled, tool } from '@openai/agents';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

setTracingDisabled(true);
setDefaultModelProvider(
  new OpenAIProvider({
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    useResponses: false,
  }),
);

const categories = ['man_and_van', 'eot_cleaning', 'furniture_service', 'housing', 'job', 'second_hand', 'other'] as const;
const called: Array<{ tool: string; args: unknown }> = [];

const upsertDemand = tool({
  name: 'upsert_demand',
  description: 'Record or update the user\'s service demand. Call this when the message asks for a service (man & van, cleaning, furniture assembly/removal).',
  parameters: z.object({
    category: z.enum(categories),
    whenText: z.string().nullable(),
    fromPostcode: z.string().nullable(),
    toPostcode: z.string().nullable(),
    quantity: z.string().nullable(),
    budgetPence: z.number().int().nullable(),
    lang: z.string().length(2),
  }),
  execute: async (args) => { called.push({ tool: 'upsert_demand', args }); return 'recorded'; },
});
const upsertSupply = tool({
  name: 'upsert_supply',
  description: 'Record that the user OFFERS a service (has a van, can clean, can assemble). Not for people asking for help.',
  parameters: z.object({ category: z.enum(categories), availability: z.string().nullable(), area: z.string().nullable() }),
  execute: async (args) => { called.push({ tool: 'upsert_supply', args }); return 'recorded'; },
});
const doNothing = tool({
  name: 'do_nothing',
  description: 'Call this when the message is not a service demand or offer (chit-chat, housing search, job search, selling items).',
  parameters: z.object({ reason: z.string() }),
  execute: async (args) => { called.push({ tool: 'do_nothing', args }); return 'ok'; },
});

const agent = new Agent({
  name: 'poc-v1',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  instructions: 'You classify one Telegram group message. Call exactly one tool. Never reply with prose.',
  tools: [upsertDemand, upsertSupply, doNothing],
});

const samples = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url), 'utf8')) as Array<{ text: string; expectTool: string; expectCategory: string }>;
let pass = 0;
for (const s of samples) {
  called.length = 0;
  const t0 = Date.now();
  await run(agent, s.text);
  const first = called[0];
  const args = first?.args as { category?: string } | undefined;
  const ok = first?.tool === s.expectTool && (s.expectTool === 'do_nothing' || args?.category === s.expectCategory);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${Date.now() - t0}ms  ${s.text.slice(0, 50)}  -> ${first?.tool} ${JSON.stringify(first?.args)}`);
}
console.log(`\n${pass}/${samples.length} passed`);
```

- [ ] **Step 3: 运行**

Run: `pnpm add -Dw @openai/agents@^0.18.0 openai@^7.2.0 && set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v1-deepseek-tools/main.ts`
Expected: 打印 10 行 PASS/FAIL 与延迟；通过标准 ≥ 9/10。

- [ ] **Step 4: 记录结论**

在 `scripts/poc/README.md` V1 行填"通过/未通过 + N/10 + p50 延迟"，本文件末尾写对 P8 的影响（例如"工具 description 需要强调 exactly one tool"、"nullable 比 optional 更稳"）。

- [ ] **Step 5: Commit**

```bash
git add scripts/poc/v1-deepseek-tools package.json pnpm-lock.yaml scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V1 deepseek-flash tool calling via chat completions"
```

---

### Task 2: V2 RunState 跨进程恢复

**Files:**
- Create: `scripts/poc/v2-runstate-resume/agent.ts`（共享的 agent 定义，两个进程都用它重建同一张图）
- Create: `scripts/poc/v2-runstate-resume/pause.ts`
- Create: `scripts/poc/v2-runstate-resume/resume.ts`

**Interfaces:**
- Produces: 结论"`needsApproval` 中断 → `toString` → 新进程 `RunState.fromString` → `approve` → `run(agent, state)` 是否完整；`addInput` 在暂停期间是否生效；重复恢复同一快照是否会被 SDK 拒绝（预期不会，需要我们自己原子消费）"

- [ ] **Step 1: 共享 agent 定义**

```ts
// scripts/poc/v2-runstate-resume/agent.ts
import { Agent, OpenAIProvider, setDefaultModelProvider, setTracingDisabled, tool } from '@openai/agents';
import { z } from 'zod';

setTracingDisabled(true);
setDefaultModelProvider(new OpenAIProvider({ baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY!, useResponses: false }));

export const sent: string[] = [];
export const replyInGroup = tool({
  name: 'reply_in_group',
  description: 'Send a reply into the Telegram group. This sends a message to real people.',
  parameters: z.object({ text: z.string() }),
  needsApproval: true,
  execute: async ({ text }) => { sent.push(text); return 'sent'; },
});
export const buildAgent = () => new Agent({
  name: 'poc-v2',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  instructions: 'The user asks for a man & van. Reply in the group with two options using reply_in_group. Call the tool once.',
  tools: [replyInGroup],
});
```

- [ ] **Step 2: 暂停进程**

```ts
// scripts/poc/v2-runstate-resume/pause.ts
import { run } from '@openai/agents';
import { writeFileSync } from 'node:fs';
import { buildAgent } from './agent.js';

const result = await run(buildAgent(), 'I need a van Sunday E14 to SE1, 8 boxes');
console.log('interruptions:', result.interruptions.map((i) => ({ tool: i.rawItem.name, args: i.rawItem.arguments })));
if (result.interruptions.length === 0) throw new Error('expected an interruption');
writeFileSync('/tmp/poc-v2-state.json', result.state.toString());
console.log('state saved, bytes =', result.state.toString().length);
```

- [ ] **Step 3: 恢复进程**

```ts
// scripts/poc/v2-runstate-resume/resume.ts
import { RunState, run } from '@openai/agents';
import { readFileSync } from 'node:fs';
import { buildAgent, sent } from './agent.js';

const agent = buildAgent();
const state = await RunState.fromString(agent, readFileSync('/tmp/poc-v2-state.json', 'utf8'));
state.addInput('Also, my budget is £120 max.');
for (const i of state.getInterruptions()) state.approve(i);
const result = await run(agent, state);
console.log('final:', result.finalOutput);
console.log('sent:', sent);
// 二次恢复同一快照：验证 SDK 是否拦截（预期不拦截 → 必须靠 run_states.consume 原子化）
const again = await RunState.fromString(agent, readFileSync('/tmp/poc-v2-state.json', 'utf8'));
for (const i of again.getInterruptions()) again.approve(i);
const r2 = await run(agent, again);
console.log('second resume also ran, sent count =', sent.length, r2.finalOutput);
```

- [ ] **Step 4: 运行两个进程**

Run: `set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v2-runstate-resume/pause.ts && pnpm exec tsx scripts/poc/v2-runstate-resume/resume.ts`
Expected: pause 打印一条 `reply_in_group` 中断并保存；resume 打印 `sent` 有一条且包含预算相关内容（证明 `addInput` 生效）；second resume 又发了一次（证明必须自己做原子消费）。

- [ ] **Step 5: 记录结论并提交**

```bash
git add scripts/poc/v2-runstate-resume scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V2 RunState cross-process resume"
```

---

### Task 3: V3 Postgres 自定义 Session

**Files:**
- Create: `scripts/poc/v3-pg-session/pg-session.ts`
- Create: `scripts/poc/v3-pg-session/main.ts`
- Modify: `package.json`（devDependencies 加 `"pg": "^8.16.0"`, `"@types/pg": "^8.15.0"`）

**Interfaces:**
- Produces: 结论"实现 `Session` 接口需要哪些方法（以 SDK 类型为准），`sessionInputCallback` 是否在 string 输入时被调用"

- [ ] **Step 1: 建表并实现 Session**

```ts
// scripts/poc/v3-pg-session/pg-session.ts
import type { AgentInputItem, Session } from '@openai/agents';
import pg from 'pg';

export class PgSession implements Session {
  constructor(private readonly pool: pg.Pool, private readonly userId: string) {}
  async getSessionId() { return this.userId; }
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const r = await this.pool.query('SELECT item FROM poc_session_items WHERE user_id=$1 ORDER BY seq', [this.userId]);
    const items = r.rows.map((x) => x.item as AgentInputItem);
    return limit ? items.slice(-limit) : items;
  }
  async addItems(items: AgentInputItem[]) {
    for (const item of items) await this.pool.query('INSERT INTO poc_session_items(user_id, seq, item) VALUES ($1, (SELECT COALESCE(MAX(seq),0)+1 FROM poc_session_items WHERE user_id=$1), $2)', [this.userId, JSON.stringify(item)]);
  }
  async popItem(): Promise<AgentInputItem | null> {
    const r = await this.pool.query('DELETE FROM poc_session_items WHERE user_id=$1 AND seq=(SELECT MAX(seq) FROM poc_session_items WHERE user_id=$1) RETURNING item', [this.userId]);
    return (r.rows[0]?.item as AgentInputItem) ?? null;
  }
  async clearSession() { await this.pool.query('DELETE FROM poc_session_items WHERE user_id=$1', [this.userId]); }
}
```

若 `Session` 接口的方法名与上面不一致（以 `node_modules/@openai/agents-core` 的类型为准），改成一致并把真实签名记进结论。

- [ ] **Step 2: 主脚本**

```ts
// scripts/poc/v3-pg-session/main.ts
import { Agent, OpenAIProvider, run, setDefaultModelProvider, setTracingDisabled } from '@openai/agents';
import pg from 'pg';
import { PgSession } from './pg-session.js';

setTracingDisabled(true);
setDefaultModelProvider(new OpenAIProvider({ baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY!, useResponses: false }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query('CREATE TABLE IF NOT EXISTS poc_session_items(user_id text, seq int, item jsonb, PRIMARY KEY(user_id, seq))');
const session = new PgSession(pool, 'user-42');
await session.clearSession();
const agent = new Agent({ name: 'poc-v3', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', instructions: 'Answer in one short sentence.' });

await run(agent, 'I need a van on Sunday from E14.', { session });
const r2 = await run(agent, 'To SE1, about 8 boxes. Where am I moving from?', { session });
console.log('turn 2 answer:', r2.finalOutput);
console.log('stored items:', (await session.getItems()).length);
await pool.end();
```

- [ ] **Step 3: 运行**

Run: `pnpm add -Dw pg@^8.16.0 @types/pg@^8.15.0 && pnpm infra:up && set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v3-pg-session/main.ts`
Expected: turn 2 的回答提到 E14（证明历史被带入）；stored items ≥ 4。

- [ ] **Step 4: 记录结论并提交**

```bash
git add scripts/poc/v3-pg-session package.json pnpm-lock.yaml scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V3 postgres session"
```

---

### Task 4: V4 Jev 入站问题集 precision 与延迟

**Files:**
- Create: `scripts/poc/v4-jev-inbound/main.ts`
- Create: `scripts/poc/v4-jev-inbound/labeled.json`（50 条真实或仿真群消息，人工标 `is_demand`、`category`；由执行者从 Brief §4 的群里抓或自造，中英俄乌葡各 ≥ 8 条）

**Interfaces:**
- Produces: 结论"入站问题集 precision、p50/p95 延迟、每条平均 input tokens"；`labeled.json` 后续被 P12 复用

- [ ] **Step 1: 写脚本**

```ts
// scripts/poc/v4-jev-inbound/main.ts
import { readFileSync } from 'node:fs';

const labeled = JSON.parse(readFileSync(new URL('./labeled.json', import.meta.url), 'utf8')) as Array<{ text: string; group: string; is_demand: boolean; category: string }>;
const questions = {
  is_demand: { type: 'noul', instructions: 'Is the author asking for a paid local service (moving, cleaning, furniture assembly/removal) for themselves?', criteria: { true: 'Explicit request for a service', false: 'Chit-chat, offering a service, selling items, housing/job search' } },
  is_supply: { type: 'noul', instructions: 'Is the author OFFERING a service (has a van, can clean, can assemble)?' },
  category: { type: 'choice', instructions: 'Which category best fits the message?', criteria: { man_and_van: 'Moving, van, transport of boxes/furniture', eot_cleaning: 'End of tenancy / deep cleaning', furniture_service: 'Assembly, disassembly, furniture delivery or disposal', housing: 'Looking for or offering a room/flat', job: 'Looking for or offering work', second_hand: 'Buying or selling used items', other: 'None of the above' } },
  urgency: { type: 'score', instructions: 'How soon is the service needed?', criteria: ['No time given', 'Within a week', 'Within three days', 'Tomorrow', 'Today'] },
  has_location: { type: 'noul', instructions: 'Does the message contain a usable location (postcode, area, station)?' },
  is_sensitive: { type: 'noul', instructions: 'Does the message involve currency exchange, crypto, or paying on someone\'s behalf?' },
  is_move_event: { type: 'noul', instructions: 'Does the message imply the author is about to move home (looking for a room, leaving a tenancy, bought large furniture)?' },
};
let tp = 0, fp = 0, fn = 0, catOk = 0, tokens = 0;
const lat: number[] = [];
for (const s of labeled) {
  const t0 = Date.now();
  const res = await fetch(`${process.env.JEV_BASE_URL ?? 'https://api.typesafe.ai'}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.JEV_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.JEV_MODEL ?? 'jev-latest', state: { text: s.text, group: s.group }, questions }),
  });
  lat.push(Date.now() - t0);
  if (!res.ok) { console.log('HTTP', res.status, await res.text()); continue; }
  const j = (await res.json()) as { answers: Record<string, { noul?: number; choice?: string }>; usage: { input_tokens: number } };
  tokens += j.usage.input_tokens;
  const pred = (j.answers.is_demand?.noul ?? 0) >= 0.7;
  if (pred && s.is_demand) tp++; else if (pred && !s.is_demand) fp++; else if (!pred && s.is_demand) fn++;
  if (j.answers.category?.choice === s.category) catOk++;
  console.log(`${pred === s.is_demand ? 'ok ' : 'BAD'} demand=${j.answers.is_demand?.noul?.toFixed(2)} cat=${j.answers.category?.choice}/${s.category}  ${s.text.slice(0, 50)}`);
}
lat.sort((a, b) => a - b);
console.log(`\nprecision=${(tp / (tp + fp)).toFixed(2)} recall=${(tp / (tp + fn)).toFixed(2)} category_acc=${(catOk / labeled.length).toFixed(2)} p50=${lat[Math.floor(lat.length / 2)]}ms p95=${lat[Math.floor(lat.length * 0.95)]}ms avg_tokens=${Math.round(tokens / labeled.length)}`);
```

- [ ] **Step 2: 运行**

Run: `set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v4-jev-inbound/main.ts`
Expected: precision ≥ 0.9，p95 < 2000ms。未达标时调整 `instructions`/`criteria` 文案重跑，并把最终版本写入结论（P4 直接采用）。

- [ ] **Step 3: 记录结论并提交**

```bash
git add scripts/poc/v4-jev-inbound scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V4 jev inbound question set"
```

---

### Task 5: V5 grammY 收群消息

**Files:**
- Create: `scripts/poc/v5-telegram-groups/main.ts`
- Modify: `package.json`（devDependencies 加 `"grammy": "^1.46.0"`）

**Interfaces:**
- Produces: 结论"Bot 在关闭 privacy mode 或成为管理员后，长轮询能否收到群内非 @ 文本；`update.message` 里 `from.id`、`chat.id`、`message_id`、`from.language_code` 的实际取值"

- [ ] **Step 1: 写脚本**

```ts
// scripts/poc/v5-telegram-groups/main.ts
import { Bot } from 'grammy';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
bot.on('message:text', (ctx) => {
  const m = ctx.message;
  console.log(JSON.stringify({ chatType: m.chat.type, chatId: m.chat.id, chatTitle: 'title' in m.chat ? m.chat.title : undefined, messageId: m.message_id, fromId: m.from?.id, lang: m.from?.language_code, text: m.text.slice(0, 80), replyTo: m.reply_to_message?.message_id }));
});
console.log('listening (long polling); post messages in a test group and observe');
await bot.start();
```

- [ ] **Step 2: 运行**

Run: `pnpm add -Dw grammy@^1.46.0 && set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v5-telegram-groups/main.ts`
手动：在 BotFather 执行 `/setprivacy` → Disable；把 Bot 拉进一个测试群；由另一个账号发一条不 @ Bot 的文本。
Expected: 终端打印该消息的 JSON。记录 `chat.id` 为负数、`from.id` 为正数等事实。

- [ ] **Step 3: 记录结论并提交**

```bash
git add scripts/poc/v5-telegram-groups package.json pnpm-lock.yaml scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V5 telegram group ingestion"
```

---

### Task 6: V6 自定义 tracing processor

**Files:**
- Create: `scripts/poc/v6-tracing/main.ts`

**Interfaces:**
- Produces: 结论"禁用默认导出后，自定义 processor 收到的 span 类型与字段（agent / generation / function），token usage 在哪个 span 上"

- [ ] **Step 1: 写脚本**

```ts
// scripts/poc/v6-tracing/main.ts
import { Agent, OpenAIProvider, run, setDefaultModelProvider, setTraceProcessors, tool } from '@openai/agents';
import type { Span, Trace, TracingProcessor } from '@openai/agents';
import { z } from 'zod';

const seen: Array<{ kind: string; type: string; data: unknown }> = [];
const processor: TracingProcessor = {
  async onTraceStart(t: Trace) { seen.push({ kind: 'trace', type: 'start', data: { id: t.traceId } }); },
  async onTraceEnd(t: Trace) { seen.push({ kind: 'trace', type: 'end', data: { id: t.traceId } }); },
  async onSpanStart(_s: Span<unknown>) {},
  async onSpanEnd(s: Span<unknown>) { seen.push({ kind: 'span', type: s.spanData.type, data: s.spanData }); },
  async shutdown() {},
  async forceFlush() {},
};
setTraceProcessors([processor]);   // 替换默认 OpenAI 导出
setDefaultModelProvider(new OpenAIProvider({ baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY!, useResponses: false }));

const echo = tool({ name: 'echo', description: 'Echo text', parameters: z.object({ text: z.string() }), execute: async ({ text }) => text });
const agent = new Agent({ name: 'poc-v6', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', instructions: 'Call echo with the user text, then answer "done".', tools: [echo] });
await run(agent, 'hello tracing');
for (const s of seen) console.log(s.kind, s.type, JSON.stringify(s.data).slice(0, 200));
```

若 `setTraceProcessors` / `TracingProcessor` 的导出名不同，以 `node_modules/@openai/agents-core/dist` 的实际导出为准并记入结论。

- [ ] **Step 2: 运行**

Run: `set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v6-tracing/main.ts`
Expected: 看到 `agent`、`generation`（含 usage）、`function` 三类 span；网络上没有对 `api.openai.com/v1/traces` 的请求（可用 `NODE_DEBUG=net` 或代理确认）。

- [ ] **Step 3: 记录结论并提交**

```bash
git add scripts/poc/v6-tracing scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V6 custom tracing processor"
```

---

## 完成记录

| PoC | 结论（通过/未通过） | 证据 | 对 P8 的影响 | 日期 | 执行者 |
|---|---|---|---|---|---|
| V1 | | | | | |
| V2 | | | | | |
| V3 | | | | | |
| V4 | | | | | |
| V5 | | | | | |
| V6 | | | | | |
