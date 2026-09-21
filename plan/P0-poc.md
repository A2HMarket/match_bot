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

- [x] **Step 1: 准备 10 条样例**

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

- [x] **Step 2: 写脚本**

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

- [x] **Step 3: 运行**

Run: `pnpm add -Dw @openai/agents@^0.18.0 openai@^7.2.0 && set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v1-deepseek-tools/main.ts`
Expected: 打印 10 行 PASS/FAIL 与延迟；通过标准 ≥ 9/10。

- [x] **Step 4: 记录结论**

在 `scripts/poc/README.md` V1 行填"通过/未通过 + N/10 + p50 延迟"，本文件末尾写对 P8 的影响（例如"工具 description 需要强调 exactly one tool"、"nullable 比 optional 更稳"）。

- [x] **Step 5: Commit**

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

- [x] **Step 1: 共享 agent 定义**

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

- [x] **Step 2: 暂停进程**

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

- [x] **Step 3: 恢复进程**

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

- [x] **Step 4: 运行两个进程**

Run: `set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v2-runstate-resume/pause.ts && pnpm exec tsx scripts/poc/v2-runstate-resume/resume.ts`
Expected: pause 打印一条 `reply_in_group` 中断并保存；resume 打印 `sent` 有一条且包含预算相关内容（证明 `addInput` 生效）；second resume 又发了一次（证明必须自己做原子消费）。

- [x] **Step 5: 记录结论并提交**

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

- [x] **Step 1: 建表并实现 Session**

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

- [x] **Step 2: 主脚本**

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

- [x] **Step 3: 运行**

Run: `pnpm add -Dw pg@^8.16.0 @types/pg@^8.15.0 && pnpm infra:up && set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v3-pg-session/main.ts`
Expected: turn 2 的回答提到 E14（证明历史被带入）；stored items ≥ 4。

- [x] **Step 4: 记录结论并提交**

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

- [x] **Step 1: 写脚本**

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

- [x] **Step 2: 运行**

Run: `set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v4-jev-inbound/main.ts`
Expected: precision ≥ 0.9，p95 < 2000ms。未达标时调整 `instructions`/`criteria` 文案重跑，并把最终版本写入结论（P4 直接采用）。

- [x] **Step 3: 记录结论并提交**

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

- [x] **Step 1: 写脚本**

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

- [x] **Step 2: 运行**

Run: `pnpm add -Dw grammy@^1.46.0 && set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v5-telegram-groups/main.ts`
手动：在 BotFather 执行 `/setprivacy` → Disable；把 Bot 拉进一个测试群；由另一个账号发一条不 @ Bot 的文本。
Expected: 终端打印该消息的 JSON。记录 `chat.id` 为负数、`from.id` 为正数等事实。

- [x] **Step 3: 记录结论并提交**

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

- [x] **Step 1: 写脚本**

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

- [x] **Step 2: 运行**

Run: `set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v6-tracing/main.ts`
Expected: 看到 `agent`、`generation`（含 usage）、`function` 三类 span；网络上没有对 `api.openai.com/v1/traces` 的请求（可用 `NODE_DEBUG=net` 或代理确认）。

- [x] **Step 3: 记录结论并提交**

```bash
git add scripts/poc/v6-tracing scripts/poc/README.md plan/P0-poc.md
git commit -m "chore(poc): V6 custom tracing processor"
```

---

## 完成记录

每项的完整三段结论见 `scripts/poc/vN-*/RESULT.md`，本表是摘要。六项由 6 个子 agent 并行执行，提交与看板回写由协调者串行完成。

| PoC | 结论 | 证据 | 对 P8 的影响 | 日期 | 执行者 |
|---|---|---|---|---|---|
| V1 | **通过** 10/10 | 6 轮真实运行约 60 次调用，从未以散文代替工具调用；`stop_on_first_tool` p50 1458ms / p95 1826ms | ① `toolChoice: 'required'` **不可用**（deepseek-flash 是思考模型，返回 400 `Thinking mode does not support this tool_choice`），必须靠 instructions + `do_nothing` 兜底工具；② 默认 `toolUseBehavior: 'run_llm_again'` 每轮 1–2/10 产生重复工具调用 = 重复写库，**必须设 `stop_on_first_tool`**（计划未提，`agent.d.ts:105`）；③ 参数用 `nullable` 而非 `optional`（strict JSON Schema 要求全必填，`optional` 只是 DeepSeek 不强制 strict 才侥幸可用）；④ 延迟预算 2s / 超时 5s，勿放 webhook 同步路径 | 2026-09-21 | 子 agent |
| V2 | **通过** | 两个独立进程经文件传递快照；`sent` 0→1；二次恢复同一快照 `sent` 2→3 | ① **SDK 不拦截重复恢复**，§3.3 第 6 条的原子消费是唯一防线（实测非推测）；② **批准一次 ≠ 跑完**：首次恢复仍返回 1 个中断且 `finalOutput === undefined`，`resume_run` 必须循环、新写 `pending` 行、再发审批卡，完成判据用 `interruptions.length === 0`；③ 最小快照 22.7KB（待发文案存了 5 份）含原始群消息明文 → `bytea` + 先 gzip（8.8×）后加密，7 天过期须物理清空；④ `fromString` 按 agent 名绑图，但**改 instructions 不报错**，旧快照会用新 instructions 跑 → `AGENT_VERSION` + `run_states.sdk_version` 必须自己把关；⑤ 用 `fromStringWithContext` 才能还原自己的 `RunContext` | 2026-09-21 | 子 agent |
| V3 | **通过** | turn 2 答 `You're moving from E14.`（E14 仅出现在 turn 1）；stored items = 4，每轮 +2 | ① 真实 `Session` 接口 5 必需 + 4 可选，`popItem()` 返回 `| undefined` 而非计划写的 `| null`（按计划写 strict 下 TS2416）；② **deepseek-flash 把整段思维链塞进 `content[].providerData.reasoning_content` 并落库回放**，实测一句 12 词回答换 2420 字节 → 写库前剥离，并实现 `prepareHistoryItemForModelInput` 在回放时摘掉；③ runner **从不**给 `getItems` 传 `limit`，裁剪窗口必须自己做，且截断不可拆散 `function_call` / `function_call_result`；④ SDK 从不调 `popItem()` 但 compaction 路径会调 `clearSession()`；⑤ `seq` 用 `MAX(seq)+1` 有并发竞态，仓储需 `FOR UPDATE` 或全局 `bigserial` | 2026-09-21 | 子 agent |
| V4 | **通过** | n=50，precision 1.00（tp=22 fp=0）、recall 1.00、category 0.98（22 条真需求上 1.00）；p50 324ms / p95 408ms；avg 1087 input tokens；$0.0000457/条 | ① 问题集 `QUESTIONS_V3` 由 P4 逐字采用（消融：v0 plan 原文 category 0.94 → v3 加 "classify by SUBJECT MATTER only" 后 0.98 且消除抖动）；② 阈值建议 `T_IS_DEMAND_ENTER = 0.70`（正类最低 0.86、负类最高 0.13，0.14–0.85 是空带）、`T_IS_SUPPLY_RECORD = 0.80` 且必须与 `category ∈ SERVICE_CATEGORIES` 取与（求职者落在 0.46–0.72）、`T_IS_SENSITIVE_REJECT = 0.50`；③ `has_location` / `is_move_event` 本集无金标，Phase 0 只打标签**不得进门**；④ 响应含 `usage.cost`（USD float → `cost_micro = round(cost*1e6)`，不需价格表）、顶层 `id`、且 `model` 回显钉死日期版 `typesafe/jev-1.13-20260917` —— 该版本号必须进 `decision_traces`，版本一变上述阈值全部作废；⑤ `category` 按**主题**而非意图判定，绝不能单独当作"这是需求"；`urgency` 在非需求上也会打高分，只在 `is_demand` 门之后有意义 | 2026-09-21 | 子 agent |
| V5 | **通过** | 关闭 privacy 并新建群后实收一条不 @ bot 的中文群消息：`{"chatType":"group","chatId":-5522461480,"chatIdIsNegative":true,"messageId":4,"fromId":8804415352,"hasLang":false,"mentionsBot":false,"text":"周日有人有 van 吗，E14 搬到 SE1，大概 8 个箱子"}`；`getMe.can_read_all_group_messages` 由 false 变 true | ① privacy mode 是硬前提且**只对关闭后新加入的群生效**，`channel-telegram` 启动时应 `getMe` 断言 `can_read_all_group_messages === true`，否则拒绝启动而非静默空转；② **实测** `chat.id = -5522461480`（负）、`from.id = 8804415352`（正），均超 32 位 → Telegram int64 id **必须以字符串入库**（§4.1），唯一键是 `(channel, chatExternalId, externalId)`，`message_id` 仅在单个 chat 内唯一；③ **实测 `language_code` 缺失**（`hasLang: false`）——该条为中文却无任何语言信息，`lang` 须可空且**不得作为语种判定的唯一依据**，语种应由文本推断，`language_code` 仅作弱先验；④ 建群会自动产生 `group_chat_created` 等**服务消息**（本次 messageId 1/2/3 均为非文本），`channel-telegram` 必须过滤，否则会被当成用户输入送进 agent；⑤ `allowed_updates` 必须显式声明才收得到 `my_chat_member`（实测收到 `left → member`）；长轮询与 `getUpdates` 互斥（409） | 2026-09-21 | 子 agent + 人工建群 |
| V6 | **通过** | 一次 run 收到 16 事件 / **5 类 span**（计划只预期 3 类）：`task` `agent` `turn` `generation` `function`；双探针（`globalThis.fetch` + `net.Socket.prototype.connect`）证明只联 `api.deepseek.com`，对照组保留默认 exporter 立即抓到 `POST api.openai.com/v1/traces/ingest` ×3 | ① **token usage 不在 `generation` span 上**（与计划假设相反），由 runner 写在 `turn.spanData.usage`（单次调用）与 `task.spanData.usage`（整个 run，含 `requests`/`total_tokens`），见 `runner/tracing.js:118-128`；latency 在 `span.startedAt/endedAt` 不在 `spanData` → `decision_traces` 一行 = 一个 `turn`，按 `generation.parentId === turn.spanId` 归并；② `traceIncludeSensitiveData` / `traceMetadata` 属 **`RunConfig`**，只能 `new Runner(config)` 传，塞进 `run()` 会被静默忽略 → `packages/agent` 必须持有 Runner 实例；`phase` 经 `traceMetadata` 注入；③ span 含原文（system instructions、用户原话、`reasoning_content`、工具参数），落库前须按 §6/§3.3-11 处理；④ `Span.end()` 内部 `void processor.onSpanEnd(...).catch()` —— 不 await 且吞异常，processor 必须自己 try/catch、**深拷贝 spanData**（SDK 就地复用对象，`usage` 是 end 前一刻才挂）、缓冲批量写、退出前 `await getGlobalTraceProvider().forceFlush()`；⑤ `setTracingDisabled(true)` **不能**用来满足 §3.3 第 9 条（连 span 都没有，第 2 条就没数据）；`addTraceProcessor` 是追加不是替换，建议加单测断言列表里没有 `OpenAITracingExporter`；⑥ `NODE_ENV === 'test'` 全局关 tracing，单测须用假 span | 2026-09-21 | 子 agent |

## 对后续工作包的跨项结论

1. **`zod` 原本无法从仓库根解析**（只声明在 `packages/*`，未提升），已 `pnpm add -Dw zod@^4.6.5` 修复。`packages/agent` 仍须在自己的 `dependencies` 显式声明 `zod@^4.6.5` 并与 `@openai/agents` 版本对齐，避免双实例。
2. **Jev 走 OpenRouter decisions 端点**：`POST https://openrouter.ai/api/alpha/decisions`，`model: typesafe/jev-1.13`。直连 `api.typesafe.ai/v1/systemone` 用当前 key 返回 401。P4 的客户端按此实现，`.env.example` 已更新。
3. **两处"计划代码与 SDK 实际行为冲突"已按 plan/README.md §6 回写本文件**：V3 的 `Session.popItem` 返回类型、V6 的 usage 所在 span。
4. `eslint.config.js` 的 ignores 由 `scripts/poc/**/*.js` 修正为 `scripts/poc/**`——PoC 实际是 `.ts`，原 glob 写漏导致 `pnpm lint` 失败；这是落实本文件既有的"不要求通过 lint"约定，不是放宽生产代码检查。
