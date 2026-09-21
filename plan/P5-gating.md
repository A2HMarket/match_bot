# P5 gating 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"要不要进 agent"和"出站是自动、送审还是 dry-run"两个决定做成纯规则函数，加频控与黑名单。

**Architecture:** 全部是输入到输出的纯函数，唯一的 IO 是频控查 `outbound.countSentToTargetSince`。阈值集中在 `thresholds.ts`，业务代码不写裸数字。

**Tech Stack:** TypeScript、vitest（表驱动）

**Spec:** `plan/interfaces.md` §gating；`docs/技术架构设计.md` §3 三个门、§7 阶段放行；PRD §6.2 沉默设计

## Global Constraints

- 本包禁止依赖 `@matchbot/jev` 与 `@openai/agents`（AGENTS.md §3.2，check-deps 强制）。它只消费 verdict 的数值。
- 阈值命名 `T_<question>_<action>`（AGENTS.md §4.4）。
- Phase 0 一律 `dry_run`；Jev 不可用（verdict 为 null）时出站一律 `review`（AGENTS.md §3.3 第 4、5 条）。
- 每条规则至少一个正例一个反例（AGENTS.md §7）。

---

### Task 1: thresholds + resolvePhase + isBlacklisted

**Files:**
- Create: `packages/gating/src/thresholds.ts`、`phase.ts`、`blacklist.ts`
- Modify: `packages/gating/src/index.ts`
- Test: `packages/gating/tests/phase.test.ts`、`tests/blacklist.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// packages/gating/tests/phase.test.ts
import { describe, expect, it } from 'vitest';
import { resolvePhase } from '../src/phase.js';

const group = (phase: number) => ({ phase }) as never;
describe('resolvePhase', () => {
  it.each([
    [group(2), 0, 2],
    [group(0), 2, 0],
    [null, 1, 1],
  ])('group %o default %i -> %i', (g, d, expected) => {
    expect(resolvePhase({ group: g, defaultPhase: d as 0 | 1 | 2 })).toBe(expected);
  });
});
```

```ts
// packages/gating/tests/blacklist.test.ts
import { describe, expect, it } from 'vitest';
import { isBlacklisted } from '../src/blacklist.js';

describe('isBlacklisted', () => {
  it.each([
    ['有人换汇吗 人民币换英镑', true],
    ['need USDT for cash', true],
    ['can someone pay on my behalf and I transfer later', true],
    ['need a van on sunday', false],
    ['exchange student looking for a room', false],
  ])('%s -> %s', (text, expected) => {
    expect(isBlacklisted(text)).toBe(expected);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/gating/tests/phase.test.ts packages/gating/tests/blacklist.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/gating/src/thresholds.ts
/** 初值来自架构文档；Phase 0 结束后用标注样本校准并在此更新（AGENTS.md §8 第 3 条）。 */
export interface Thresholds {
  T_IS_DEMAND_ENTER: number;
  T_IS_SUPPLY_ENTER: number;
  T_IS_SENSITIVE_DROP: number;
  T_IS_MOVE_EVENT_TAG: number;
  T_WORTH_REPLYING_AUTO: number;
  T_LANGUAGE_OK_AUTO: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  T_IS_DEMAND_ENTER: 0.7,
  T_IS_SUPPLY_ENTER: 0.7,
  T_IS_SENSITIVE_DROP: 0.5,
  T_IS_MOVE_EVENT_TAG: 0.6,
  T_WORTH_REPLYING_AUTO: 2.2,
  T_LANGUAGE_OK_AUTO: 0.8,
};
```

```ts
// packages/gating/src/phase.ts
import type { Phase } from '@matchbot/domain';

/** 群级 phase 覆盖全局默认；群未接入（null）用默认（架构 §7）。 */
export function resolvePhase(p: { group: { phase: number } | null; defaultPhase: Phase }): Phase {
  const v = p.group?.phase ?? p.defaultPhase;
  return (v === 0 || v === 1 || v === 2 ? v : p.defaultPhase) as Phase;
}
```

```ts
// packages/gating/src/blacklist.ts
/** 换汇 / 虚拟币 / 代付 硬拒（PRD §4.3）。关键词表是第一道，Jev is_sensitive 是第二道。 */
const PATTERNS: RegExp[] = [
  /换汇|換匯|换钱|人民币换|换英镑|换镑/i,
  /\b(usdt|usdc|btc|eth|crypto|bitcoin|binance)\b/i,
  /обмен\s*валют|обменяю|курс\s*фунт/i,
  /câmbio|troco\s+libras/i,
  /代付|帮付|pay (on|for) my behalf|pay for me and/i,
];
export function isBlacklisted(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
```

`index.ts` re-export 三者。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/gating/tests/phase.test.ts packages/gating/tests/blacklist.test.ts`
Expected: 8 passed

- [x] **Step 5: Commit**

```bash
git add packages/gating
git commit -m "feat(gating): thresholds, phase resolution and blacklist"
```

---

### Task 2: decideInbound

**Files:**
- Create: `packages/gating/src/inbound.ts`
- Modify: `packages/gating/src/index.ts`
- Test: `packages/gating/tests/inbound.test.ts`

**Interfaces:**
- Consumes: verdict 形状 `{ isDemand, isSupply, category, isSensitive, isMoveEvent }`（与 `@matchbot/jev` 的 `InboundVerdict` 结构相同，但本包用自己的结构类型声明，不 import jev）
- Produces: `decideInbound(v, t): InboundDecision`

- [x] **Step 1: 写失败测试**

```ts
// packages/gating/tests/inbound.test.ts
import { describe, expect, it } from 'vitest';
import { decideInbound } from '../src/inbound.js';
import { DEFAULT_THRESHOLDS as T } from '../src/thresholds.js';

const base = { isDemand: 0, isSupply: 0, category: 'other' as const, isSensitive: 0, isMoveEvent: 0 };
describe('decideInbound', () => {
  it.each([
    ['sensitive wins', { ...base, isDemand: 0.99, category: 'man_and_van' as const, isSensitive: 0.9 }, { action: 'drop', reason: 'sensitive' }],
    ['service demand enters', { ...base, isDemand: 0.8, category: 'man_and_van' as const }, { action: 'enter_agent', category: 'man_and_van', kind: 'demand' }],
    ['service supply enters', { ...base, isSupply: 0.75, category: 'man_and_van' as const }, { action: 'enter_agent', category: 'man_and_van', kind: 'supply' }],
    ['both', { ...base, isDemand: 0.8, isSupply: 0.8, category: 'eot_cleaning' as const }, { action: 'enter_agent', category: 'eot_cleaning', kind: 'both' }],
    ['housing with move event tags', { ...base, isDemand: 0.9, category: 'housing' as const, isMoveEvent: 0.7 }, { action: 'tag_move_event' }],
    ['housing without move event drops', { ...base, isDemand: 0.9, category: 'housing' as const, isMoveEvent: 0.1 }, { action: 'drop', reason: 'not_demand' }],
    ['low confidence drops', { ...base, isDemand: 0.4, category: 'man_and_van' as const }, { action: 'drop', reason: 'not_demand' }],
  ])('%s', (_n, v, expected) => {
    expect(decideInbound(v, T)).toEqual(expected);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/gating/tests/inbound.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/gating/src/inbound.ts
import { isServiceCategory, type DemandCategory } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface InboundSignals { isDemand: number; isSupply: number; category: DemandCategory; isSensitive: number; isMoveEvent: number }
export type InboundDecision =
  | { action: 'drop'; reason: 'sensitive' | 'not_demand' }
  | { action: 'tag_move_event' }
  | { action: 'enter_agent'; category: DemandCategory; kind: 'demand' | 'supply' | 'both' };

/** 顺序即优先级：敏感 > 非服务品类打标签 > 进 agent > 丢弃（架构 §3、PRD §4.3）。 */
export function decideInbound(v: InboundSignals, t: Thresholds): InboundDecision {
  if (v.isSensitive >= t.T_IS_SENSITIVE_DROP) return { action: 'drop', reason: 'sensitive' };
  const demand = v.isDemand >= t.T_IS_DEMAND_ENTER;
  const supply = v.isSupply >= t.T_IS_SUPPLY_ENTER;
  if (!isServiceCategory(v.category)) {
    return v.isMoveEvent >= t.T_IS_MOVE_EVENT_TAG ? { action: 'tag_move_event' } : { action: 'drop', reason: 'not_demand' };
  }
  if (demand && supply) return { action: 'enter_agent', category: v.category, kind: 'both' };
  if (demand) return { action: 'enter_agent', category: v.category, kind: 'demand' };
  if (supply) return { action: 'enter_agent', category: v.category, kind: 'supply' };
  return { action: 'drop', reason: 'not_demand' };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/gating/tests/inbound.test.ts`
Expected: 7 passed

- [x] **Step 5: Commit**

```bash
git add packages/gating
git commit -m "feat(gating): decideInbound"
```

---

### Task 3: decideOutbound + createRateLimiter

**Files:**
- Create: `packages/gating/src/outbound.ts`、`rate-limit.ts`
- Modify: `packages/gating/src/index.ts`
- Test: `packages/gating/tests/outbound.test.ts`、`tests/rate-limit.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// packages/gating/tests/outbound.test.ts
import { describe, expect, it } from 'vitest';
import { decideOutbound } from '../src/outbound.js';
import { DEFAULT_THRESHOLDS as t } from '../src/thresholds.js';

const good = { worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0.01 };
describe('decideOutbound', () => {
  it.each([
    ['phase 0 always dry_run', { phase: 0, verdict: good, rateOk: true }, 'dry_run'],
    ['phase 1 always review', { phase: 1, verdict: good, rateOk: true }, 'review'],
    ['phase 2 auto when good and rate ok', { phase: 2, verdict: good, rateOk: true }, 'auto'],
    ['phase 2 review when rate exceeded', { phase: 2, verdict: good, rateOk: false }, 'review'],
    ['phase 2 review when jev unavailable', { phase: 2, verdict: null, rateOk: true }, 'review'],
    ['phase 2 review when language doubtful', { phase: 2, verdict: { ...good, languageOk: 0.5 }, rateOk: true }, 'review'],
    ['phase 2 drop when not worth it', { phase: 2, verdict: { ...good, worthReplying: 0.8 }, rateOk: true }, 'drop'],
    ['phase 2 drop when unverified supplier', { phase: 2, verdict: { ...good, mentionsUnverified: 0.9 }, rateOk: true }, 'drop'],
  ])('%s', (_n, p, expected) => {
    expect(decideOutbound({ ...p, phase: p.phase as 0 | 1 | 2, t })).toBe(expected);
  });
});
```

```ts
// packages/gating/tests/rate-limit.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/rate-limit.js';

describe('createRateLimiter', () => {
  it('allows below limit, blocks at limit', async () => {
    const count = vi.fn(async () => 2);
    const rl = createRateLimiter({ countSentToTargetSince: count } as never);
    expect(await rl.check({ target: '-1', limitPerDay: 3, now: new Date() })).toBe(true);
    count.mockResolvedValueOnce(3);
    expect(await rl.check({ target: '-1', limitPerDay: 3, now: new Date() })).toBe(false);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/gating/tests/outbound.test.ts packages/gating/tests/rate-limit.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/gating/src/outbound.ts
import type { Phase } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface OutboundSignals { worthReplying: number; languageOk: number; mentionsUnverified: number }
export type OutboundDecision = 'dry_run' | 'review' | 'auto' | 'drop';
const T_MENTIONS_UNVERIFIED_DROP = 0.5;
const T_WORTH_REPLYING_DROP = 1.0;

/** Phase 0 不发；Phase 1 全审；Phase 2 才看分数。Jev 不可用永远送审（AGENTS.md §3.3 第 4、5 条）。 */
export function decideOutbound(p: { phase: Phase; verdict: OutboundSignals | null; rateOk: boolean; t: Thresholds }): OutboundDecision {
  if (p.phase === 0) return 'dry_run';
  if (p.phase === 1) return 'review';
  if (!p.verdict) return 'review';
  if (p.verdict.mentionsUnverified >= T_MENTIONS_UNVERIFIED_DROP) return 'drop';
  if (p.verdict.worthReplying < T_WORTH_REPLYING_DROP) return 'drop';
  if (!p.rateOk) return 'review';
  if (p.verdict.worthReplying >= p.t.T_WORTH_REPLYING_AUTO && p.verdict.languageOk >= p.t.T_LANGUAGE_OK_AUTO) return 'auto';
  return 'review';
}
```

```ts
// packages/gating/src/rate-limit.ts
import type { Repositories } from '@matchbot/db';

/** 频控按 target（群 chat id）按自然日计 sent 条数（PRD §6.2 "一个群一天三次就是广告机器人"）。 */
export function createRateLimiter(outbound: Pick<Repositories['outbound'], 'countSentToTargetSince'>) {
  return {
    async check(p: { target: string; limitPerDay: number; now: Date }): Promise<boolean> {
      const dayStart = new Date(Date.UTC(p.now.getUTCFullYear(), p.now.getUTCMonth(), p.now.getUTCDate()));
      return (await outbound.countSentToTargetSince(p.target, dayStart)) < p.limitPerDay;
    },
  };
}
```

把 `T_MENTIONS_UNVERIFIED_DROP`、`T_WORTH_REPLYING_DROP` 移进 `Thresholds`（interfaces.md 同步加两项）。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/gating/tests/outbound.test.ts packages/gating/tests/rate-limit.test.ts`
Expected: 9 passed

- [x] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿（含 check-deps：gating 未依赖 jev）

```bash
git add packages/gating plan/interfaces.md
git commit -m "feat(gating): decideOutbound and rate limiter"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | 完成 |
| 执行者 | subagent-driven-development via Claude Code |
| PR | 留空（未开 PR） |
| 与 interfaces.md 的偏差 | 无，仅补充了 `tag_move_event` 的注释澄清（适用于任意非服务品类，不限于 housing/job/second_hand） |
| 备注 | |
