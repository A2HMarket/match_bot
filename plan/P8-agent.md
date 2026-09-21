# P8 agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 OpenAI Agents SDK 组装 `matchAgent`：模型接入、Postgres Session、十个工具、出站门、guardrails、tracing processor，以及 `runInbound` / `resumeRun` 两个入口。

**Architecture:** `provider.ts` 只做模型与 tracing 初始化；`session.ts` 实现 SDK `Session` 接口落 `session_items`；`tools/*.ts` 一个文件一个工具，出站工具共用 `outbound-gate.ts` 的 `needsApproval` 与 `execute`；`agent.ts` 组装；`run.ts` 提供两个入口并把中断快照写 `run_states`。所有测试用 stub `ModelProvider`，不联网。

**Tech Stack:** `@openai/agents` 0.18、zod 4、vitest

**Spec:** `plan/interfaces.md` §agent；`docs/技术架构设计.md` §4、§5；`AGENTS.md` §3.3；PoC V1、V2、V3、V6 的完成记录（**开工前必须已通过**）

## Global Constraints

- 只有本包 import `@openai/agents`（AGENTS.md §3.2）。
- 出站工具全部走 `outbound-gate.ts`；工具里不得各自判断 phase（AGENTS.md §3.3 第 3、4 条）。
- 出站只写 `outbound_messages`，不调 Telegram（AGENTS.md §3.3 第 3 条）。
- 初始化必须 `setTraceProcessors([...])` 替换默认导出（AGENTS.md §3.3 第 9 条）。SDK 导出名以 PoC V6 结论为准。
- `Session` 接口方法名以 PoC V3 结论为准；本计划按 `getSessionId / getItems / addItems / popItem / clearSession` 写。
- 改 instructions 或工具描述必须递增 `AGENT_VERSION`（AGENTS.md §8 第 4 条）。
- 每个出站工具四条用例：Phase 0 dry-run、Phase 1 送审、Phase 2 自动、Phase 2 送审（AGENTS.md §7）。

---

### Task 1: provider 与 tracing processor

**Files:**
- Create: `packages/agent/src/provider.ts`
- Create: `packages/agent/src/tracing.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/tests/tracing.test.ts`

**Interfaces:**
- Produces: `configureModelProvider(env: Env): void`、`createTraceProcessor(p: { traces: Repositories['traces']; phase: () => Phase }): TracingProcessor`

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent/tests/tracing.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createTraceProcessor } from '../src/tracing.js';

describe('createTraceProcessor', () => {
  it('writes one agent_run trace per span end with usage cost', async () => {
    const traces = { create: vi.fn(async () => ({}) as never), listByKind: vi.fn() };
    const proc = createTraceProcessor({ traces, phase: () => 1 });
    const span = { spanData: { type: 'generation', usage: { input_tokens: 1000, output_tokens: 200 }, model: 'deepseek-flash' }, startedAt: '2026-09-25T10:00:00.000Z', endedAt: '2026-09-25T10:00:01.500Z', traceId: 't1' } as never;
    await proc.onSpanEnd(span);
    expect(traces.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_run', inputRef: 't1', phase: 1, latencyMs: 1500, costMicro: expect.any(Number) }));
    const call = (traces.create.mock.calls[0] as unknown[])[0] as { costMicro: number };
    expect(call.costMicro).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/agent/tests/tracing.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/agent/src/provider.ts
import type { Env } from '@matchbot/shared';
import { OpenAIProvider, setDefaultModelProvider, setTraceProcessors } from '@openai/agents';
import type { TracingProcessor } from '@openai/agents';

/** deepseek-flash 走 Chat Completions；默认 tracing 导出被替换（架构 §4.1）。只在进程启动调一次。 */
export function configureModelProvider(env: Env, processors: TracingProcessor[]): void {
  setTraceProcessors(processors);
  setDefaultModelProvider(new OpenAIProvider({ baseURL: env.DEEPSEEK_BASE_URL, apiKey: env.DEEPSEEK_API_KEY, useResponses: false }));
}
```

```ts
// packages/agent/src/tracing.ts
import type { Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import type { Span, Trace, TracingProcessor } from '@openai/agents';

// deepseek-flash 定价（USD / 1M tokens）；以 DeepSeek 官网为准，变动时改这里
const PRICE_IN_MICRO_PER_TOKEN = 0.14;
const PRICE_OUT_MICRO_PER_TOKEN = 0.28;

export function createTraceProcessor(p: { traces: Repositories['traces']; phase: () => Phase }): TracingProcessor {
  return {
    async onTraceStart(_t: Trace) {},
    async onTraceEnd(_t: Trace) {},
    async onSpanStart(_s: Span<unknown>) {},
    async onSpanEnd(s: Span<unknown>) {
      const data = s.spanData as { type: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const usage = data.usage ?? {};
      const cost = Math.round((usage.input_tokens ?? 0) * PRICE_IN_MICRO_PER_TOKEN + (usage.output_tokens ?? 0) * PRICE_OUT_MICRO_PER_TOKEN);
      const latency = s.startedAt && s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : 0;
      await p.traces.create({ kind: 'agent_run', inputRef: s.traceId, output: data, phase: p.phase(), latencyMs: Math.max(0, latency), costMicro: cost });
    },
    async shutdown() {},
    async forceFlush() {},
  };
}
```

`Span` 的 `startedAt/endedAt/traceId` 字段名以 PoC V6 打印的实际结构为准；不一致就改这里并回写本计划。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/agent/tests/tracing.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): model provider and decision-trace tracing processor"
```

---

### Task 2: Postgres Session

**Files:**
- Create: `packages/agent/src/session.ts`
- Test: `packages/agent/tests/session.test.ts`

**Interfaces:**
- Produces: `createPgSession(p: { repos: Repositories; userId: string }): Session`

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent/tests/session.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createPgSession } from '../src/session.js';

function repos() {
  const store: unknown[] = [];
  return {
    sessionItems: {
      list: vi.fn(async (_u: string, limit?: number) => (limit ? store.slice(-limit) : [...store])),
      append: vi.fn(async (_u: string, items: unknown[]) => { store.push(...items); }),
      popLast: vi.fn(async () => store.pop() ?? null),
      clear: vi.fn(async () => { store.length = 0; }),
    },
  } as never;
}

describe('createPgSession', () => {
  it('delegates to sessionItems repo with the user id', async () => {
    const r = repos();
    const s = createPgSession({ repos: r, userId: 'u1' });
    expect(await s.getSessionId()).toBe('u1');
    await s.addItems([{ role: 'user', content: 'hi' }] as never);
    expect(await s.getItems()).toHaveLength(1);
    expect(await s.popItem()).toEqual({ role: 'user', content: 'hi' });
    await s.clearSession();
    expect(await s.getItems()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/agent/tests/session.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/agent/src/session.ts
import type { Repositories } from '@matchbot/db';
import type { AgentInputItem, Session } from '@openai/agents';

/** Session 粒度 = 用户（AGENTS.md §3.3 第 7 条）。群上下文与画像走 instructions，不进 session。 */
export function createPgSession(p: { repos: Repositories; userId: string }): Session {
  return {
    async getSessionId() { return p.userId; },
    async getItems(limit?: number) { return (await p.repos.sessionItems.list(p.userId, limit)) as AgentInputItem[]; },
    async addItems(items: AgentInputItem[]) { await p.repos.sessionItems.append(p.userId, items); },
    async popItem() { return (await p.repos.sessionItems.popLast(p.userId)) as AgentInputItem | null; },
    async clearSession() { await p.repos.sessionItems.clear(p.userId); },
  };
}
```

若 SDK 的 `Session` 还要求 `SessionHistoryTransactionAwareSession.applyHistoryTransaction`，按 PoC V3 结论补充，用 `repos.sessionItems.append(userId, items, operationId)` 实现 `append_items`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/agent/tests/session.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): postgres-backed session"
```

---

### Task 3: 出站门与出站工具

**Files:**
- Create: `packages/agent/src/context.ts`（`MatchContext`、`AgentDeps`）
- Create: `packages/agent/src/tools/outbound-gate.ts`
- Create: `packages/agent/src/tools/reply-in-group.ts`、`notify-user.ts`、`ask-clarification.ts`、`push-lead.ts`
- Test: `packages/agent/tests/tools/outbound-gate.test.ts`

**Interfaces:**
- Produces: `makeOutboundTool(p: { name; description; target: (ctx, args) => string; text: (ctx, args) => string; deps })`，四个工具由它生成

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent/tests/tools/outbound-gate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { decideForOutbound, executeOutbound } from '../../src/tools/outbound-gate.js';

const deps = () => ({
  repos: { outbound: { create: vi.fn(async (d: unknown, status: string) => ({ id: 'om', status, ...(d as object) })), countSentToTargetSince: vi.fn(async () => 0) }, traces: { create: vi.fn(async () => ({})) } },
  jev: { evaluate: vi.fn() },
  evaluateOutbound: vi.fn(async () => ({ ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 })),
  thresholds: { T_IS_DEMAND_ENTER: 0.7, T_IS_SUPPLY_ENTER: 0.7, T_IS_SENSITIVE_DROP: 0.5, T_IS_MOVE_EVENT_TAG: 0.6, T_WORTH_REPLYING_AUTO: 2.2, T_LANGUAGE_OK_AUTO: 0.8, T_MENTIONS_UNVERIFIED_DROP: 0.5, T_WORTH_REPLYING_DROP: 1.0 },
  logger: { info: vi.fn(), warn: vi.fn() },
}) as never;
const ctx = (phase: 0 | 1 | 2) => ({ userId: 'u', chatId: '-1', groupId: 'g', phase, recentReplies: [], demand: { category: 'man_and_van', confidence: 0.9 } }) as never;
const draft = { target: '-1', text: '3 options', supplierSummaries: ['Van Co'], inputRef: 'r1' };

describe('decideForOutbound', () => {
  it('phase 0 -> dry_run without calling jev', async () => {
    const d = deps();
    expect(await decideForOutbound(d, ctx(0), draft)).toBe('dry_run');
    expect((d as { evaluateOutbound: ReturnType<typeof vi.fn> }).evaluateOutbound).not.toHaveBeenCalled();
  });
  it('phase 1 -> review', async () => { expect(await decideForOutbound(deps(), ctx(1), draft)).toBe('review'); });
  it('phase 2 good verdict -> auto', async () => { expect(await decideForOutbound(deps(), ctx(2), draft)).toBe('auto'); });
  it('phase 2 jev down -> review', async () => {
    const d = deps();
    (d as { evaluateOutbound: ReturnType<typeof vi.fn> }).evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    expect(await decideForOutbound(d, ctx(2), draft)).toBe('review');
  });
});

describe('executeOutbound', () => {
  it('writes dry_run row in phase 0 and pending row otherwise, with disclaimer appended', async () => {
    const d = deps();
    await executeOutbound(d, ctx(0), { ...draft, toolCallId: 'c1' }, 'dry_run');
    await executeOutbound(d, ctx(2), { ...draft, toolCallId: 'c2' }, 'auto');
    const create = (d as { repos: { outbound: { create: ReturnType<typeof vi.fn> } } }).repos.outbound.create;
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: expect.stringContaining('not part of the transaction') }), 'dry_run');
    expect(create).toHaveBeenNthCalledWith(2, expect.anything(), 'pending');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/agent/tests/tools/outbound-gate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/agent/src/context.ts
import type { Repositories } from '@matchbot/db';
import type { DemandDraft, Phase } from '@matchbot/domain';
import type { Thresholds } from '@matchbot/gating';
import type { JevClient, evaluateOutbound } from '@matchbot/jev';
import type { Env, Logger } from '@matchbot/shared';

export interface MatchContext { userId: string; chatId: string; groupId: string | null; phase: Phase; demand?: DemandDraft; recentReplies: string[]; sourceMessageId: string }
export interface AgentDeps {
  env: Env; repos: Repositories; jev: JevClient; thresholds: Thresholds; logger: Logger;
  evaluateOutbound: typeof evaluateOutbound;   // 注入便于测试
}
```

```ts
// packages/agent/src/tools/outbound-gate.ts
import { createRateLimiter, decideOutbound, type OutboundDecision } from '@matchbot/gating';
import type { RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';

export interface OutboundDraftInput { target: string; text: string; supplierSummaries: string[]; inputRef: string; toolCallId?: string }
const DISCLAIMER = '\n\nContact them directly for a quote — we are not part of the transaction.';

/** 三个门里的出站门（架构 §3）：阶段 → Jev 出站分 → 频控。Phase 0/1 不调 Jev，省钱。 */
export async function decideForOutbound(deps: AgentDeps, ctx: MatchContext, d: OutboundDraftInput): Promise<OutboundDecision> {
  if (ctx.phase !== 2) return decideOutbound({ phase: ctx.phase, verdict: null, rateOk: true, t: deps.thresholds });
  const v = ctx.demand ? await deps.evaluateOutbound(deps.jev, { draft: d.text, demand: ctx.demand, supplierSummaries: d.supplierSummaries, recentReplies: ctx.recentReplies, inputRef: d.inputRef, phase: ctx.phase }) : null;
  const rateOk = await createRateLimiter(deps.repos.outbound).check({ target: d.target, limitPerDay: 3, now: new Date() });
  const decision = decideOutbound({ phase: ctx.phase, verdict: v && v.ok ? v : null, rateOk, t: deps.thresholds });
  await deps.repos.traces.create({ kind: 'gate', inputRef: d.inputRef, output: { decision, verdict: v, rateOk }, phase: ctx.phase, latencyMs: 0, costMicro: 0 });
  return decision;
}

export async function executeOutbound(deps: AgentDeps, ctx: MatchContext, d: OutboundDraftInput, decision: OutboundDecision): Promise<string> {
  if (decision === 'drop') return 'not sent: gate dropped it';
  const status = decision === 'dry_run' ? 'dry_run' : 'pending';
  const row = await deps.repos.outbound.create({ channel: 'telegram', target: d.target, text: d.text + DISCLAIMER, toolCallId: d.toolCallId }, status);
  return status === 'dry_run' ? `dry-run recorded (${row.id})` : `queued (${row.id})`;
}

/** needsApproval：'review' 才中断；'auto' / 'dry_run' / 'drop' 都不中断，由 execute 按 decision 处理。 */
export function outboundNeedsApproval(deps: AgentDeps) {
  return async (rc: RunContext<MatchContext>, d: OutboundDraftInput): Promise<boolean> => (await decideForOutbound(deps, rc.context, d)) === 'review';
}
```

```ts
// packages/agent/src/tools/reply-in-group.ts
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { decideForOutbound, executeOutbound, outboundNeedsApproval } from './outbound-gate.js';

export const replyInGroupParams = z.object({
  text: z.string().min(1).max(1500).describe('Reply text in the same language as the demand. Mention 2-3 suppliers with price and contact.'),
  supplierIds: z.array(z.string()).min(1).max(3),
});

export function replyInGroupTool(deps: AgentDeps) {
  return tool({
    name: 'reply_in_group',
    description: 'SENDS a message into the Telegram group under the user\'s demand. Use only after find_suppliers returned candidates. Never invent suppliers.',
    parameters: replyInGroupParams,
    needsApproval: async (rc: RunContext<MatchContext>, args) => outboundNeedsApproval(deps)(rc, await toDraft(deps, rc.context, args)),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const d = await toDraft(deps, ctx, args);
      return executeOutbound(deps, ctx, d, await decideForOutbound(deps, ctx, d));
    },
  });
}

async function toDraft(deps: AgentDeps, ctx: MatchContext, args: z.infer<typeof replyInGroupParams>) {
  const suppliers = await deps.repos.suppliers.findByIds(args.supplierIds);
  return { target: ctx.chatId, text: args.text, supplierSummaries: suppliers.map((s) => `${s.name} ${s.roughPrice ?? ''}`), inputRef: ctx.sourceMessageId };
}
```

`notify-user.ts`（target = `ctx.userId`，参数 `{ text }`）、`ask-clarification.ts`（target = `ctx.chatId`，参数 `{ question, missingFields: string[] }`，description 说明"追问缺失字段，一次只问一个"）、`push-lead.ts`（参数 `{ supplierId, demandSummary }`，target = 供应商的 `telegram` 字段；没有则返回 `'supplier has no telegram; ops will send manually'` 并写一条 `pending` 出站到 `env.TELEGRAM_OPS_CHAT_ID`）按同一模板实现。`decideForOutbound` 在 `needsApproval` 与 `execute` 各调一次，Phase 2 会产生两次 Jev 调用；用 `WeakMap<RunContext, OutboundDecision>` 缓存一次 run 内的决定。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/agent/tests/tools/outbound-gate.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): outbound gate and four outbound tools"
```

---

### Task 4: 读写工具（upsert_demand / upsert_supply / find_suppliers / find_peer_supply / close_demand / do_nothing）

**Files:**
- Create: `packages/agent/src/tools/upsert-demand.ts`、`upsert-supply.ts`、`find-suppliers.ts`、`find-peer-supply.ts`、`close-demand.ts`、`do-nothing.ts`
- Test: `packages/agent/tests/tools/upsert-demand.test.ts`、`tests/tools/find-suppliers.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent/tests/tools/upsert-demand.test.ts
import { describe, expect, it, vi } from 'vitest';
import { upsertDemandTool } from '../../src/tools/upsert-demand.js';

describe('upsert_demand', () => {
  it('creates when no open demand of that category, updates otherwise', async () => {
    const demands = { findOpenByUser: vi.fn(async () => []), create: vi.fn(async (p: unknown) => ({ id: 'd1', ...(p as object) })), update: vi.fn(async (id: string, p: unknown) => ({ id, ...(p as object) })) };
    const deps = { repos: { demands } } as never;
    const t = upsertDemandTool(deps);
    const rc = { context: { userId: 'u', sourceMessageId: 'm1' } } as never;
    await t.invoke(rc, JSON.stringify({ category: 'man_and_van', fromPostcode: 'e14 9ab', confidence: 0.9 }));
    expect(demands.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', fromPostcode: 'E149AB', sourceMessageId: 'm1' }));
    demands.findOpenByUser.mockResolvedValueOnce([{ id: 'd1', category: 'man_and_van' }] as never);
    await t.invoke(rc, JSON.stringify({ category: 'man_and_van', toPostcode: 'SE1', confidence: 0.9 }));
    expect(demands.update).toHaveBeenCalledWith('d1', expect.objectContaining({ toPostcode: 'SE1', sourceMessageId: 'm1' }));
  });
});
```

```ts
// packages/agent/tests/tools/find-suppliers.test.ts
import { describe, expect, it, vi } from 'vitest';
import { findSuppliersTool } from '../../src/tools/find-suppliers.js';

describe('find_suppliers', () => {
  it('returns top 3 scored candidates with reasons and stores matches', async () => {
    const suppliers = [{ id: 'a', category: 'man_and_van', name: 'A', serviceArea: ['LONDON'], languages: ['en'], pool: 'A', priceType: 'hourly', roughPrice: '£40/h', isSameDay: false, isWeekend: true, lastVerifiedAt: new Date(), rating: null }];
    const deps = { repos: { suppliers: { findCandidates: vi.fn(async () => suppliers) }, matches: { replaceForDemand: vi.fn(async () => []) } } } as never;
    const rc = { context: { userId: 'u', demand: { category: 'man_and_van', confidence: 0.9, fromPostcode: 'E14' }, demandId: 'd1' } } as never;
    const out = JSON.parse(await findSuppliersTool(deps).invoke(rc, '{}') as string) as Array<{ id: string; reasons: string[] }>;
    expect(out[0]?.id).toBe('a');
    expect(out[0]?.reasons.length).toBeGreaterThan(0);
  });
});
```

`tool().invoke` 的签名以 SDK 类型为准（PoC V1 时确认）；若不可直接调用，改为导出 `execute` 函数单独测。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/agent/tests/tools`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/agent/src/tools/upsert-demand.ts
import { demandDraftSchema } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import { tool, type RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';

const params = demandDraftSchema.extend({
  fromPostcode: demandDraftSchema.shape.fromPostcode.describe('UK postcode or outward code, e.g. E14 or SE1 7AB'),
});

export function upsertDemandTool(deps: AgentDeps) {
  return tool({
    name: 'upsert_demand',
    description: 'Record or update the user\'s open service demand (category, when, from/to postcode, quantity, budget). Call this whenever the user states or refines what they need.',
    parameters: params,
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const norm = { ...args, fromPostcode: args.fromPostcode ? normalizePostcode(args.fromPostcode)?.full : undefined, toPostcode: args.toPostcode ? normalizePostcode(args.toPostcode)?.full : undefined };
      const open = (await deps.repos.demands.findOpenByUser(ctx.userId)).find((d) => d.category === args.category);
      const row = open ? await deps.repos.demands.update(open.id, { ...norm, sourceMessageId: ctx.sourceMessageId }) : await deps.repos.demands.create({ ...norm, userId: ctx.userId, sourceMessageId: ctx.sourceMessageId });
      ctx.demand = norm; ctx.demandId = row.id;
      return `demand ${open ? 'updated' : 'created'}: ${row.id}`;
    },
  });
}
```

（`MatchContext` 加 `demandId?: string`，interfaces.md 同步。）

```ts
// packages/agent/src/tools/find-suppliers.ts
import { scoreSuppliers } from '@matchbot/matcher';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

export function findSuppliersTool(deps: AgentDeps) {
  return tool({
    name: 'find_suppliers',
    description: 'Find up to 3 verified suppliers for the current demand. Returns id, name, price, contact and reasons. Call upsert_demand first.',
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demand || !ctx.demandId) return 'no demand recorded yet; call upsert_demand first';
      const candidates = await deps.repos.suppliers.findCandidates({ category: ctx.demand.category });
      const scored = scoreSuppliers({ demand: ctx.demand, suppliers: candidates, now: new Date() }).slice(0, 3);
      await deps.repos.matches.replaceForDemand(ctx.demandId, scored.map((s, i) => ({ supplierId: s.id, matcherScore: s.score, rank: i + 1 })));
      const byId = new Map(candidates.map((c) => [c.id, c]));
      return JSON.stringify(scored.map((s) => { const c = byId.get(s.id)!; return { id: c.id, name: c.name, price: c.roughPrice, phone: c.phone, whatsapp: c.whatsapp, pool: c.pool, reasons: s.reasons }; }));
    },
  });
}
```

其余四个工具按同一风格：`upsert_supply`（参数 `supplyDraftSchema`，写 `repos.supplies.create`，`groupId` 来自 ctx）、`find_peer_supply`（`repos.supplies.findActive` + `scorePeerSupplies`，返回前 3）、`close_demand`（`repos.demands.setStatus(ctx.demandId, 'closed')`）、`do_nothing`（参数 `{ reason }`，返回 `'ok'`，写一条 `gate` trace 记录理由）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/agent/tests/tools`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add packages/agent plan/interfaces.md
git commit -m "feat(agent): demand/supply/matching tools"
```

---

### Task 5: agent 组装、guardrails、runInbound / resumeRun

**Files:**
- Create: `packages/agent/src/agent.ts`、`guardrails.ts`、`run.ts`
- Modify: `packages/agent/src/index.ts`（导出 `createMatchAgent`、`runInbound`、`resumeRun`、`createPgSession`、`configureModelProvider`、`createTraceProcessor`）
- Test: `packages/agent/tests/run.test.ts`

**Interfaces:**
- Produces: interfaces.md §agent 的全部签名

- [ ] **Step 1: 写失败测试（stub 模型）**

```ts
// packages/agent/tests/run.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runInbound } from '../src/run.js';

/** stub ModelProvider：第一轮调用 reply_in_group，第二轮结束。签名以 PoC V1 观察到的 Model 接口为准。 */
function stubProvider(calls: Array<{ tool: string; args: unknown } | { text: string }>) {
  let i = 0;
  return { getModel: async () => ({ getResponse: async () => { const c = calls[i++]!; return 'tool' in c ? toolCallResponse(c.tool, c.args) : textResponse(c.text); }, getStreamedResponse: async function* () {} }) };
}
declare function toolCallResponse(name: string, args: unknown): unknown;   // 在 tests/helpers/model-stub.ts 里按 SDK 的 ModelResponse 形状实现
declare function textResponse(text: string): unknown;

describe('runInbound', () => {
  it('phase 1: outbound tool interrupts and a run_state row is written', async () => {
    const runStates = { create: vi.fn(async () => ({ id: 'rs1' })) };
    const deps = { /* repos with runStates + sessionItems stubs, jev stub, thresholds, logger */ } as never;
    const r = await runInbound({ deps, ctx: { userId: 'u', chatId: '-1', groupId: 'g', phase: 1, recentReplies: [], sourceMessageId: 'm1' }, input: 'need a van', modelProvider: stubProvider([{ tool: 'reply_in_group', args: { text: 'x', supplierIds: ['a'] } }]) });
    expect(r).toEqual({ kind: 'interrupted', runStateId: 'rs1' });
    expect(runStates.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', agentVersion: expect.any(String) }));
  });
});
```

`tests/helpers/model-stub.ts` 在 PoC V1 后按 `@openai/agents-core` 的 `ModelResponse` 类型实现 `toolCallResponse` / `textResponse`；这是本任务第一步的实际工作。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/agent/tests/run.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/agent/src/guardrails.ts
import { isBlacklisted } from '@matchbot/gating';
import type { InputGuardrail, OutputGuardrail } from '@openai/agents';

/** 兜底：进 agent 前再挡一次敏感内容（Pre-gate 已挡过；这里防旁路调用）。 */
export const sensitiveInputGuardrail: InputGuardrail = {
  name: 'sensitive_input',
  runInParallel: false,
  execute: async ({ input }) => {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return { tripwireTriggered: isBlacklisted(text), outputInfo: {} };
  },
};

const GUARANTEE = /\b(guarantee|guaranteed|担保|保证|платформа гарантирует)\b/i;
export const noGuaranteeOutputGuardrail: OutputGuardrail = {
  name: 'no_guarantee',
  execute: async ({ agentOutput }) => ({ tripwireTriggered: GUARANTEE.test(String(agentOutput)), outputInfo: {} }),
};
```

```ts
// packages/agent/src/agent.ts
import { Agent, Runner } from '@openai/agents';
import type { AgentDeps, MatchContext } from './context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from './guardrails.js';
import { askClarificationTool } from './tools/ask-clarification.js';
import { closeDemandTool } from './tools/close-demand.js';
import { doNothingTool } from './tools/do-nothing.js';
import { findPeerSupplyTool } from './tools/find-peer-supply.js';
import { findSuppliersTool } from './tools/find-suppliers.js';
import { notifyUserTool } from './tools/notify-user.js';
import { pushLeadTool } from './tools/push-lead.js';
import { replyInGroupTool } from './tools/reply-in-group.js';
import { upsertDemandTool } from './tools/upsert-demand.js';
import { upsertSupplyTool } from './tools/upsert-supply.js';

export const AGENT_VERSION = '0.1.0';

const CATEGORY_NOTES: Record<string, string> = {
  man_and_van: 'Key fields: date, from postcode, to postcode, volume (boxes/rooms). Weekend and same-day matter.',
  eot_cleaning: 'Key fields: property size (studio/1-bed/2-bed), date, postcode. Guarantee period matters to tenants.',
  furniture_service: 'Key fields: item and brand (IKEA PAX etc.), assembly vs delivery vs disposal, postcode, date.',
};

export function createMatchAgent(deps: AgentDeps) {
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    instructions: (rc) => [
      'You are a helpful member of a London community group who connects people with local services (man & van, end-of-tenancy cleaning, furniture assembly/removal).',
      'You never handle payment, never guarantee quality, never recommend suppliers that find_suppliers did not return.',
      'Reply in the language of the user. Be brief. One clarifying question at a time.',
      'Housing, job and second-hand requests are not your business: call do_nothing.',
      rc.context.demand ? `Current open demand: ${JSON.stringify(rc.context.demand)}. ${CATEGORY_NOTES[rc.context.demand.category] ?? ''}` : 'No open demand yet.',
      rc.context.recentReplies.length ? `Recent replies already posted in this group: ${rc.context.recentReplies.join(' | ')}` : '',
    ].filter(Boolean).join('\n'),
    tools: [upsertDemandTool(deps), upsertSupplyTool(deps), findSuppliersTool(deps), findPeerSupplyTool(deps), askClarificationTool(deps), replyInGroupTool(deps), notifyUserTool(deps), pushLeadTool(deps), closeDemandTool(deps), doNothingTool(deps)],
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  return { agent, runner: new Runner() };
}
```

```ts
// packages/agent/src/run.ts
import type { Approval, RunState } from '@matchbot/db';
import { RunState as SdkRunState, type ModelProvider } from '@openai/agents';
import { AGENT_VERSION, createMatchAgent } from './agent.js';
import type { AgentDeps, MatchContext } from './context.js';
import { createPgSession } from './session.js';

export type RunOutcome = { kind: 'completed'; toolsCalled: string[] } | { kind: 'interrupted'; runStateId: string };
const SNAPSHOT_TTL_DAYS = 7;

export async function runInbound(p: { deps: AgentDeps; ctx: MatchContext; input: string; modelProvider?: ModelProvider }): Promise<RunOutcome> {
  const { agent, runner } = createMatchAgent(p.deps);
  const session = createPgSession({ repos: p.deps.repos, userId: p.ctx.userId });
  const result = await runner.run(agent, p.input, { context: p.ctx, session, ...(p.modelProvider ? { modelProvider: p.modelProvider } : {}) });
  return settle(p.deps, p.ctx, result);
}

export async function resumeRun(p: { deps: AgentDeps; runState: RunState; approval: Approval; ctx: MatchContext }): Promise<RunOutcome> {
  const { agent, runner } = createMatchAgent(p.deps);
  const state = await SdkRunState.fromString(agent, p.runState.snapshot);
  for (const i of state.getInterruptions()) {
    if (p.approval.decision === 'approve') state.approve(i);
    else state.reject(i, { message: p.approval.decision === 'ignore' ? 'Ops decided not to reply this time.' : 'Ops rejected this reply.' });
  }
  const session = createPgSession({ repos: p.deps.repos, userId: p.ctx.userId });
  const result = await runner.run(agent, state, { context: p.ctx, session });
  return settle(p.deps, p.ctx, result);
}

async function settle(deps: AgentDeps, ctx: MatchContext, result: Awaited<ReturnType<Runner['run']>>): Promise<RunOutcome> {
  if (result.interruptions.length > 0) {
    const row = await deps.repos.runStates.create({
      userId: ctx.userId, chatId: ctx.chatId, phase: ctx.phase, snapshot: result.state.toString(), agentVersion: AGENT_VERSION, sdkVersion: SDK_VERSION,
      interruptions: result.interruptions.map((i) => ({ tool: i.rawItem.name, args: i.rawItem.arguments })),
      expiresAt: new Date(Date.now() + SNAPSHOT_TTL_DAYS * 86400e3),
    });
    return { kind: 'interrupted', runStateId: row.id };
  }
  const toolsCalled = result.newItems.filter((i) => i.type === 'tool_call_item').map((i) => (i.rawItem as { name: string }).name);
  return { kind: 'completed', toolsCalled };
}
const SDK_VERSION = '0.18.0'; // 从 package.json 读，避免手写
```

`runner.run` 的 `modelProvider` 选项名与 `RunState` 导出名以 PoC V2 为准。`snapshot` 加密：在 `repos.runStates.create` 前用 `packages/shared` 的 `encrypt(text, env.SNAPSHOT_KEY)`（P1 未含，此处追加到 shared 并在 `.env.example` 加 `SNAPSHOT_KEY`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/agent`
Expected: 全部通过

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/agent packages/shared .env.example plan/interfaces.md
git commit -m "feat(agent): assemble matchAgent with guardrails, runInbound and resumeRun"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | |
| 执行者 | |
| PR | |
| 采用的 PoC 结论 | V1: · V2: · V3: · V6: |
| 与 interfaces.md 的偏差 | |
| AGENT_VERSION | |
