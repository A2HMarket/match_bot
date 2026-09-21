# P4 jev 客户端与问题集 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现带超时、退避、留痕的 Jev HTTP 客户端，以及入站 / 出站两套问题集与解读函数。

**Architecture:** `client.ts` 只负责 HTTP 与 `JevOutcome`；`questions/inbound.ts`、`questions/outbound.ts` 各自定义问题集并把 `answers` 解读为强类型 verdict。所有测试用注入的 `fetchImpl` 与录制 fixture，CI 不联网。

**Tech Stack:** 全局 `fetch`、zod 4、vitest 5

**Spec:** `plan/interfaces.md` §jev；`docs/reference/jev-decision-model.md` §3、§6；PoC V4 的最终问题文案（若已有）

## Global Constraints

- 只有本包能直接调用 Jev（AGENTS.md §3.3 第 1 条）。
- 每次调用写 `decision_traces(kind='jev')`，含 `latency_ms`、`cost_micro`（input_tokens × 0.042 USD/M → micro = tokens × 0.042）（AGENTS.md §3.3 第 2 条）。
- 失败返回 `{ ok: false, reason }`，不抛异常；降级方向由调用方（gating / agent）决定（AGENTS.md §3.3 第 5 条）。
- Jev 请求带 Zero Data Retention 头或字段（以官方文档为准，PoC V4 记录）。
- 同一请求内问题相互独立；有依赖的判断拆两次调用。

---

### Task 1: HTTP 客户端

**Files:**
- Create: `packages/jev/src/client.ts`
- Create: `packages/jev/src/schema.ts`（响应 zod schema）
- Modify: `packages/jev/src/index.ts`
- Create: `packages/jev/tests/fixtures/inbound-ok.json`
- Test: `packages/jev/tests/client.test.ts`

**Interfaces:**
- Produces: `createJevClient(p): JevClient`，`JevOutcome<Q>`

- [ ] **Step 1: fixture 与失败测试**

`tests/fixtures/inbound-ok.json`：

```json
{
  "model": "jev-latest",
  "answers": {
    "is_demand": { "type": "noul", "noul": 0.93 },
    "category": { "type": "choice", "choice": "man_and_van", "probabilities": { "man_and_van": 0.91, "other": 0.09 }, "confidence": 0.88 }
  },
  "usage": { "input_tokens": 412, "output_tokens": 0 }
}
```

```ts
// packages/jev/tests/client.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../src/client.js';

const ok = readFileSync(new URL('./fixtures/inbound-ok.json', import.meta.url), 'utf8');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const traces = { create: vi.fn(async () => ({}) as never), listByKind: vi.fn() };
const questions = { is_demand: { type: 'noul' as const, instructions: 'x' }, category: { type: 'choice' as const, instructions: 'y', criteria: { man_and_van: null, other: null } } };
const mk = (fetchImpl: typeof fetch) => createJevClient({ baseUrl: 'https://jev.test', apiKey: 'k', model: 'jev-latest', traces, logger, fetchImpl, timeoutMs: 50 });

describe('createJevClient', () => {
  it('returns typed answers and writes a trace with cost', async () => {
    const fetchImpl = vi.fn(async () => new Response(ok, { status: 200 })) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: { text: 'van' }, questions, inputRef: 'm1', phase: 0 });
    expect(r.ok && r.answers.category.type === 'choice' && r.answers.category.choice).toBe('man_and_van');
    expect(traces.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'jev', inputRef: 'm1', costMicro: Math.round(412 * 0.042) }));
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });
  it('retries on 429 then succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response(ok, { status: 200 })) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm2', phase: 0 });
    expect(r.ok).toBe(true);
  });
  it('gives up after 3 retries with rate_limited', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 529 })) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm3', phase: 0 });
    expect(r).toEqual({ ok: false, reason: 'rate_limited' });
  });
  it('returns timeout when fetch hangs', async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm4', phase: 0 });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });
  it('returns invalid_response on malformed body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"answers":{}}', { status: 200 })) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm5', phase: 0 });
    expect(r).toEqual({ ok: false, reason: 'invalid_response' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/jev/tests/client.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/jev/src/schema.ts
import { z } from 'zod';

const noul = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const choice = z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number() });
const score = z.object({ type: z.literal('score'), score: z.number(), legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number()), confidence: z.number() });
export const jevAnswerSchema = z.discriminatedUnion('type', [noul, choice, score]);
export const jevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
});
```

```ts
// packages/jev/src/client.ts
import type { Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import type { Logger } from '@matchbot/shared';
import { JEV_ENDPOINT, type JevAnswer, type JevQuestion } from './index.js';
import { jevResponseSchema } from './schema.js';

export type JevOutcome<Q extends string> =
  | { ok: true; answers: Record<Q, JevAnswer>; usage: { input_tokens: number } }
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' };

export interface JevClient {
  evaluate<Q extends string>(p: { state: unknown; questions: Record<Q, JevQuestion>; inputRef: string; phase: Phase }): Promise<JevOutcome<Q>>;
}

const USD_PER_INPUT_TOKEN_MICRO = 0.042; // $0.042 / 1M tokens = 0.042 micro-USD / token
const RETRY_STATUSES = new Set([429, 529]);

export function createJevClient(p: { baseUrl: string; apiKey: string; model: string; traces: Repositories['traces']; logger: Logger; fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number }): JevClient {
  const fetchImpl = p.fetchImpl ?? fetch;
  const timeoutMs = p.timeoutMs ?? 3000;
  const maxRetries = p.maxRetries ?? 3;

  async function once(body: string): Promise<{ kind: 'ok'; json: unknown } | { kind: 'retry' } | { kind: 'fail'; reason: 'timeout' | 'http_error' }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${p.baseUrl}${JEV_ENDPOINT}`, { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' }, body, signal: ac.signal });
      if (RETRY_STATUSES.has(res.status)) return { kind: 'retry' };
      if (!res.ok) return { kind: 'fail', reason: 'http_error' };
      return { kind: 'ok', json: await res.json() };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return { kind: 'fail', reason: 'timeout' };
      return { kind: 'fail', reason: 'http_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async evaluate(q) {
      const t0 = Date.now();
      const body = JSON.stringify({ model: p.model, state: q.state, questions: q.questions });
      let outcome: JevOutcome<never> | null = null;
      let parsedUsage = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const r = await once(body);
        if (r.kind === 'retry') { await new Promise((res) => setTimeout(res, 200 * 2 ** attempt)); continue; }
        if (r.kind === 'fail') { outcome = { ok: false, reason: r.reason }; break; }
        const parsed = jevResponseSchema.safeParse(r.json);
        if (!parsed.success) { outcome = { ok: false, reason: 'invalid_response' }; break; }
        parsedUsage = parsed.data.usage.input_tokens;
        outcome = { ok: true, answers: parsed.data.answers as never, usage: { input_tokens: parsedUsage } };
        break;
      }
      outcome ??= { ok: false, reason: 'rate_limited' };
      await p.traces.create({ kind: 'jev', inputRef: q.inputRef, output: outcome, phase: q.phase, latencyMs: Date.now() - t0, costMicro: Math.round(parsedUsage * USD_PER_INPUT_TOKEN_MICRO) });
      if (!outcome.ok) p.logger.warn({ reason: outcome.reason, inputRef: q.inputRef }, 'jev unavailable');
      return outcome as never;
    },
  };
}
```

把 `index.ts` 里已有的类型定义移到 `packages/jev/src/types.ts`，`index.ts` 只 re-export（避免 `client.ts` 与 `index.ts` 互相 import）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/jev/tests/client.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/jev
git commit -m "feat(jev): http client with timeout, backoff and tracing"
```

---

### Task 2: 入站问题集与 evaluateInbound

**Files:**
- Create: `packages/jev/src/questions/inbound.ts`
- Modify: `packages/jev/src/index.ts`
- Test: `packages/jev/tests/questions/inbound.test.ts`

**Interfaces:**
- Produces: `inboundQuestions()`、`evaluateInbound(client, p)`、`InboundVerdict`

- [ ] **Step 1: 写失败测试**

```ts
// packages/jev/tests/questions/inbound.test.ts
import { INBOUND_QUESTION_IDS } from '@matchbot/domain';
import { describe, expect, it, vi } from 'vitest';
import type { JevClient } from '../../src/client.js';
import { evaluateInbound, inboundQuestions } from '../../src/questions/inbound.js';

describe('inboundQuestions', () => {
  it('covers exactly the domain question ids and category keys equal DemandCategory', () => {
    const q = inboundQuestions();
    expect(Object.keys(q).sort()).toEqual([...INBOUND_QUESTION_IDS].sort());
    const cat = q.category;
    expect(cat.type === 'choice' && Object.keys(cat.criteria).sort()).toEqual(['eot_cleaning', 'furniture_service', 'housing', 'job', 'man_and_van', 'other', 'second_hand']);
  });
});

describe('evaluateInbound', () => {
  it('maps answers to a verdict', async () => {
    const client: JevClient = { evaluate: vi.fn(async () => ({ ok: true, usage: { input_tokens: 1 }, answers: {
      is_demand: { type: 'noul', noul: 0.9 }, is_supply: { type: 'noul', noul: 0.1 },
      category: { type: 'choice', choice: 'man_and_van', probabilities: { man_and_van: 0.9 }, confidence: 0.85 },
      urgency: { type: 'score', score: 3.2, legend: {}, probabilities: {}, confidence: 0.7 },
      has_location: { type: 'noul', noul: 0.95 }, is_sensitive: { type: 'noul', noul: 0.01 }, is_move_event: { type: 'noul', noul: 0.2 },
    } })) as never };
    const v = await evaluateInbound(client, { text: 'van sunday E14', groupName: 'g', recentTexts: [], inputRef: 'm1', phase: 0 });
    expect(v).toMatchObject({ ok: true, isDemand: 0.9, category: 'man_and_van', categoryConfidence: 0.85, urgency: 3.2, hasLocation: 0.95 });
  });
  it('passes through unavailability', async () => {
    const client: JevClient = { evaluate: vi.fn(async () => ({ ok: false, reason: 'timeout' })) as never };
    expect(await evaluateInbound(client, { text: 'x', groupName: 'g', recentTexts: [], inputRef: 'm2', phase: 0 })).toEqual({ ok: false, reason: 'timeout' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/jev/tests/questions/inbound.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/jev/src/questions/inbound.ts
import { DEMAND_CATEGORIES, type DemandCategory, type InboundQuestionId, type Phase } from '@matchbot/domain';
import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';

/** 文案以 PoC V4 校准后的版本为准；这里是 docs/reference/jev-decision-model.md §6 的初版。 */
export function inboundQuestions(): Record<InboundQuestionId, JevQuestion> {
  return {
    is_demand: { type: 'noul', instructions: 'Is the author asking for a paid local service (moving, cleaning, furniture assembly/removal) for themselves?', criteria: { true: 'Explicit request for a service', false: 'Chit-chat, offering a service, selling items, housing/job search' } },
    is_supply: { type: 'noul', instructions: 'Is the author OFFERING a service (has a van, can clean, can assemble)?' },
    category: { type: 'choice', instructions: 'Which category best fits the message?', criteria: {
      man_and_van: 'Moving, van, transport of boxes/furniture', eot_cleaning: 'End of tenancy / deep cleaning', furniture_service: 'Assembly, disassembly, furniture delivery or disposal',
      housing: 'Looking for or offering a room/flat', job: 'Looking for or offering work', second_hand: 'Buying or selling used items', other: 'None of the above',
    } },
    urgency: { type: 'score', instructions: 'How soon is the service needed?', criteria: ['No time given', 'Within a week', 'Within three days', 'Tomorrow', 'Today'] },
    has_location: { type: 'noul', instructions: 'Does the message contain a usable location (postcode, area, station)?' },
    is_sensitive: { type: 'noul', instructions: 'Does the message involve currency exchange, crypto, or paying on someone\'s behalf?' },
    is_move_event: { type: 'noul', instructions: 'Does the message imply the author is about to move home (looking for a room, leaving a tenancy, bought large furniture)?' },
  };
}

export interface InboundVerdict {
  ok: true;
  isDemand: number; isSupply: number; category: DemandCategory; categoryConfidence: number;
  urgency: number; hasLocation: number; isSensitive: number; isMoveEvent: number;
}

function noul(a: { type: string; noul?: number }): number { return a.type === 'noul' && typeof a.noul === 'number' ? a.noul : 0; }

export async function evaluateInbound(client: JevClient, p: { text: string; groupName: string; lang?: string; recentTexts: string[]; inputRef: string; phase: Phase }): Promise<InboundVerdict | { ok: false; reason: string }> {
  const r = await client.evaluate({ state: { text: p.text, group: p.groupName, lang: p.lang, recent_messages_from_author: p.recentTexts }, questions: inboundQuestions(), inputRef: p.inputRef, phase: p.phase });
  if (!r.ok) return r;
  const a = r.answers;
  const cat = a.category.type === 'choice' ? a.category : null;
  const category = cat && (DEMAND_CATEGORIES as readonly string[]).includes(cat.choice) ? (cat.choice as DemandCategory) : 'other';
  return {
    ok: true,
    isDemand: noul(a.is_demand), isSupply: noul(a.is_supply),
    category, categoryConfidence: cat?.confidence ?? 0,
    urgency: a.urgency.type === 'score' ? a.urgency.score : 0,
    hasLocation: noul(a.has_location), isSensitive: noul(a.is_sensitive), isMoveEvent: noul(a.is_move_event),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/jev/tests/questions/inbound.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/jev
git commit -m "feat(jev): inbound question set and verdict mapping"
```

---

### Task 3: 出站问题集与 evaluateOutbound

**Files:**
- Create: `packages/jev/src/questions/outbound.ts`
- Modify: `packages/jev/src/index.ts`
- Test: `packages/jev/tests/questions/outbound.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/jev/tests/questions/outbound.test.ts
import { OUTBOUND_QUESTION_IDS } from '@matchbot/domain';
import { describe, expect, it, vi } from 'vitest';
import type { JevClient } from '../../src/client.js';
import { evaluateOutbound, outboundQuestions } from '../../src/questions/outbound.js';

describe('outbound', () => {
  it('question ids match domain', () => {
    expect(Object.keys(outboundQuestions()).sort()).toEqual([...OUTBOUND_QUESTION_IDS].sort());
  });
  it('maps to verdict', async () => {
    const client: JevClient = { evaluate: vi.fn(async () => ({ ok: true, usage: { input_tokens: 1 }, answers: {
      worth_replying: { type: 'score', score: 2.6, legend: {}, probabilities: {}, confidence: 0.8 },
      language_ok: { type: 'noul', noul: 0.97 }, mentions_unverified: { type: 'noul', noul: 0.02 },
    } })) as never };
    const v = await evaluateOutbound(client, { draft: 'Here are 3 options', demand: { category: 'man_and_van', confidence: 0.9 }, supplierSummaries: ['Van Co £40/h'], recentReplies: [], inputRef: 'r1', phase: 1 });
    expect(v).toEqual({ ok: true, worthReplying: 2.6, languageOk: 0.97, mentionsUnverified: 0.02 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/jev/tests/questions/outbound.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/jev/src/questions/outbound.ts
import type { DemandDraft, OutboundQuestionId, Phase } from '@matchbot/domain';
import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';

export function outboundQuestions(): Record<OutboundQuestionId, JevQuestion> {
  return {
    worth_replying: { type: 'score', instructions: 'Given the demand and the draft reply, how valuable is posting this reply in the group?', criteria: ['Not useful or off-topic', 'Marginal', 'Useful', 'Clearly useful and specific'] },
    language_ok: { type: 'noul', instructions: 'Is the draft written in the same language as the demand?' },
    mentions_unverified: { type: 'noul', instructions: 'Does the draft mention any supplier not present in the provided supplier list?' },
  };
}

export interface OutboundVerdict { ok: true; worthReplying: number; languageOk: number; mentionsUnverified: number }

export async function evaluateOutbound(client: JevClient, p: { draft: string; demand: DemandDraft; supplierSummaries: string[]; recentReplies: string[]; inputRef: string; phase: Phase }): Promise<OutboundVerdict | { ok: false; reason: string }> {
  const r = await client.evaluate({ state: { draft: p.draft, demand: p.demand, suppliers: p.supplierSummaries, recent_group_replies: p.recentReplies }, questions: outboundQuestions(), inputRef: p.inputRef, phase: p.phase });
  if (!r.ok) return r;
  const a = r.answers;
  return {
    ok: true,
    worthReplying: a.worth_replying.type === 'score' ? a.worth_replying.score : 0,
    languageOk: a.language_ok.type === 'noul' ? a.language_ok.noul : 0,
    mentionsUnverified: a.mentions_unverified.type === 'noul' ? a.mentions_unverified.noul : 1,
  };
}
```

`index.ts` re-export `client.js`、`questions/inbound.js`、`questions/outbound.js`、`types.js`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/jev/tests/questions/outbound.test.ts`
Expected: 2 passed

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/jev
git commit -m "feat(jev): outbound question set"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | |
| 执行者 | |
| PR | |
| 与 interfaces.md 的偏差 | |
| PoC V4 校准后替换的文案 | |
