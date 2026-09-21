# P1 domain + shared 补全 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `interfaces.md` 里 domain 与 shared 的新增项实现出来，让波次 1 的其他包有共同的类型可依赖。

**Architecture:** `domain` 只有 zod schema、常量、纯函数；`shared` 只有无业务语义的工具。两者都不做 IO。

**Tech Stack:** TypeScript 5.9、zod 4、vitest 5、node:crypto

**Spec:** `plan/interfaces.md` §shared、§domain；`AGENTS.md` §4

## Global Constraints

- `domain` 不得 import 任何有 IO 的模块（AGENTS.md §3.2）。
- 常量集合用 `as const` 数组 + 派生联合类型，不用 TS `enum`（AGENTS.md §4.2）。
- 测试放 `packages/<pkg>/tests/`，路径镜像 `src`（AGENTS.md §4.2）。
- 每步结束 `pnpm check` 必须全绿。

---

### Task 1: shared.hashText

**Files:**
- Create: `packages/shared/src/hash.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/tests/hash.test.ts`

**Interfaces:**
- Produces: `hashText(text: string): string`（sha256 hex，小写，64 字符）

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/tests/hash.test.ts
import { describe, expect, it } from 'vitest';
import { hashText } from '../src/hash.js';

describe('hashText', () => {
  it('returns sha256 hex', () => {
    expect(hashText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is stable across calls', () => {
    expect(hashText('x')).toBe(hashText('x'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/shared/tests/hash.test.ts`
Expected: FAIL，找不到模块 `../src/hash.js`

- [ ] **Step 3: 实现**

```ts
// packages/shared/src/hash.ts
import { createHash } from 'node:crypto';

/** messages.text 30 天后置空，只留哈希用于去重与审计（架构 §9）。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
```

`packages/shared/src/index.ts` 追加 `export * from './hash.js';`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/shared/tests/hash.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add hashText"
```

---

### Task 2: domain 草稿 schema（Demand / Supply / Outbound）

**Files:**
- Create: `packages/domain/src/drafts.ts`
- Modify: `packages/domain/src/demand.ts`（加 `isServiceCategory`）
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/tests/drafts.test.ts`

**Interfaces:**
- Produces: `demandDraftSchema`/`DemandDraft`、`supplyDraftSchema`/`SupplyDraft`、`outboundDraftSchema`/`OutboundDraft`、`isServiceCategory(c)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/domain/tests/drafts.test.ts
import { describe, expect, it } from 'vitest';
import { demandDraftSchema, outboundDraftSchema, supplyDraftSchema } from '../src/drafts.js';
import { isServiceCategory } from '../src/demand.js';

describe('demandDraftSchema', () => {
  it('accepts a minimal valid draft', () => {
    const d = demandDraftSchema.parse({ category: 'man_and_van', confidence: 0.9 });
    expect(d.category).toBe('man_and_van');
  });
  it('rejects confidence out of range', () => {
    expect(() => demandDraftSchema.parse({ category: 'man_and_van', confidence: 1.5 })).toThrow();
  });
  it('rejects non-integer budgetPence', () => {
    expect(() => demandDraftSchema.parse({ category: 'man_and_van', confidence: 0.5, budgetPence: 12.5 })).toThrow();
  });
});

describe('supplyDraftSchema', () => {
  it('requires expiresAt as ISO datetime', () => {
    expect(() => supplyDraftSchema.parse({ category: 'man_and_van', expiresAt: 'tomorrow' })).toThrow();
    expect(supplyDraftSchema.parse({ category: 'man_and_van', expiresAt: '2026-10-01T00:00:00Z' }).category).toBe('man_and_van');
  });
});

describe('outboundDraftSchema', () => {
  it('requires channel, target, text', () => {
    expect(() => outboundDraftSchema.parse({ channel: 'telegram', text: 'hi' })).toThrow();
    expect(outboundDraftSchema.parse({ channel: 'telegram', target: '-100123', text: 'hi' }).target).toBe('-100123');
  });
});

describe('isServiceCategory', () => {
  it('is true only for paid categories', () => {
    expect(isServiceCategory('man_and_van')).toBe(true);
    expect(isServiceCategory('housing')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/domain/tests/drafts.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/domain/src/drafts.ts
import { z } from 'zod';
import { DEMAND_CATEGORIES } from './demand.js';

/** agent 工具与仓储之间传递的需求草稿。postcode 为归一化后的 outward 或 full。 */
export const demandDraftSchema = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  whenText: z.string().max(200).optional(),
  whenAt: z.string().datetime().optional(),
  fromPostcode: z.string().max(8).optional(),
  toPostcode: z.string().max(8).optional(),
  quantity: z.string().max(100).optional(),
  budgetPence: z.number().int().nonnegative().optional(),
  lang: z.string().length(2).optional(),
  confidence: z.number().min(0).max(1),
});
export type DemandDraft = z.infer<typeof demandDraftSchema>;

export const supplyDraftSchema = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  availability: z.string().max(200).optional(),
  area: z.string().max(100).optional(),
  expiresAt: z.string().datetime(),
});
export type SupplyDraft = z.infer<typeof supplyDraftSchema>;

export const outboundDraftSchema = z.object({
  channel: z.enum(['telegram', 'whatsapp']),
  target: z.string().min(1),
  text: z.string().min(1).max(4000),
  toolCallId: z.string().optional(),
});
export type OutboundDraft = z.infer<typeof outboundDraftSchema>;
```

`packages/domain/src/demand.ts` 追加：

```ts
export function isServiceCategory(c: DemandCategory): boolean {
  return SERVICE_CATEGORIES.includes(c);
}
```

`packages/domain/src/index.ts` 追加 `export * from './drafts.js';`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/domain/tests/drafts.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): add demand/supply/outbound draft schemas"
```

---

### Task 3: domain 留痕与 Jev 问题 id 常量

**Files:**
- Create: `packages/domain/src/trace.ts`
- Create: `packages/domain/src/jev-questions.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/tests/trace.test.ts`

**Interfaces:**
- Produces: `TRACE_KINDS`/`TraceKind`、`decisionTraceInputSchema`/`DecisionTraceInput`、`INBOUND_QUESTION_IDS`/`InboundQuestionId`、`OUTBOUND_QUESTION_IDS`/`OutboundQuestionId`

- [ ] **Step 1: 写失败测试**

```ts
// packages/domain/tests/trace.test.ts
import { describe, expect, it } from 'vitest';
import { decisionTraceInputSchema, TRACE_KINDS } from '../src/trace.js';
import { INBOUND_QUESTION_IDS, OUTBOUND_QUESTION_IDS } from '../src/jev-questions.js';

describe('decisionTraceInputSchema', () => {
  it('defaults costMicro to 0', () => {
    const t = decisionTraceInputSchema.parse({ kind: 'jev', inputRef: 'msg_1', output: { a: 1 }, phase: 0, latencyMs: 12 });
    expect(t.costMicro).toBe(0);
  });
  it('rejects unknown kind', () => {
    expect(() => decisionTraceInputSchema.parse({ kind: 'llm', inputRef: 'x', output: {}, phase: 0, latencyMs: 1 })).toThrow();
  });
  it('exposes all kinds', () => {
    expect(TRACE_KINDS).toEqual(['rule', 'jev', 'agent_run', 'gate']);
  });
});

describe('question ids', () => {
  it('inbound and outbound ids do not overlap', () => {
    const overlap = INBOUND_QUESTION_IDS.filter((id) => (OUTBOUND_QUESTION_IDS as readonly string[]).includes(id));
    expect(overlap).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/domain/tests/trace.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/domain/src/trace.ts
import { z } from 'zod';

export const TRACE_KINDS = ['rule', 'jev', 'agent_run', 'gate'] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/** 每一次判断都要留痕（AGENTS.md §3.3 第 2 条）。costMicro 单位 1e-6 USD。 */
export const decisionTraceInputSchema = z.object({
  kind: z.enum(TRACE_KINDS),
  inputRef: z.string().min(1),
  output: z.unknown(),
  phase: z.number().int().min(0).max(2),
  latencyMs: z.number().int().nonnegative(),
  costMicro: z.number().int().nonnegative().default(0),
});
export type DecisionTraceInput = z.infer<typeof decisionTraceInputSchema>;
```

```ts
// packages/domain/src/jev-questions.ts
/** Jev 问题 id。choice 的 option key 与 DemandCategory 完全一致（AGENTS.md §4.4）。 */
export const INBOUND_QUESTION_IDS = [
  'is_demand',
  'is_supply',
  'category',
  'urgency',
  'has_location',
  'is_sensitive',
  'is_move_event',
] as const;
export type InboundQuestionId = (typeof INBOUND_QUESTION_IDS)[number];

export const OUTBOUND_QUESTION_IDS = ['worth_replying', 'language_ok', 'mentions_unverified'] as const;
export type OutboundQuestionId = (typeof OUTBOUND_QUESTION_IDS)[number];
```

`index.ts` 追加两行 export。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/domain/tests/trace.test.ts`
Expected: 4 passed

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/domain
git commit -m "feat(domain): add decision trace schema and jev question ids"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | |
| 执行者 | |
| PR | |
| 与 interfaces.md 的偏差 | |
| 备注 | |
