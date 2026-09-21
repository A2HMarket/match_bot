# P6 matcher 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用确定性规则给候选供应商与群内供给打分并给出理由，agent 只在其上做排序与文案。

**Architecture:** 纯函数。分项打分（区域覆盖、A/B 池、档期、价格类型、语言、新鲜度）加权求和到 0–1，每一项命中都往 `reasons` 推一句，供审批卡与回复引用。

**Tech Stack:** TypeScript、vitest

**Spec:** `plan/interfaces.md` §matcher；`docs/技术架构设计.md` §4.2 `find_suppliers`、§5 供应商贴合

## Global Constraints

- 不调用任何模型（AGENTS.md §3.2）。
- postcode 比较用 `@matchbot/shared` 的 `normalizePostcode` 的 `outward`。
- B 池供应商分数上限 0.6，保证 A 池优先（架构 §7 取舍 T7）。

---

### Task 1: scoreSuppliers

**Files:**
- Create: `packages/matcher/src/score-suppliers.ts`
- Create: `packages/matcher/src/types.ts`
- Modify: `packages/matcher/src/index.ts`
- Test: `packages/matcher/tests/score-suppliers.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/matcher/tests/score-suppliers.test.ts
import { describe, expect, it } from 'vitest';
import { scoreSuppliers } from '../src/score-suppliers.js';

const now = new Date('2026-09-25T10:00:00Z');
const sup = (over: Partial<Parameters<typeof scoreSuppliers>[0]['suppliers'][number]>) => ({
  id: 's', category: 'man_and_van', name: 'S', serviceArea: ['LONDON'], languages: ['en'], pool: 'A', isSameDay: false, isWeekend: false, priceType: 'hourly', rating: null, lastVerifiedAt: now, ...over,
}) as never;
const demand = { category: 'man_and_van' as const, confidence: 0.9, fromPostcode: 'E14', lang: 'ru', whenAt: '2026-09-27T09:00:00Z' };

describe('scoreSuppliers', () => {
  it('ranks area match + language + weekend above generic', () => {
    const r = scoreSuppliers({ demand, suppliers: [sup({ id: 'generic' }), sup({ id: 'fit', serviceArea: ['E14', 'E1'], languages: ['en', 'ru'], isWeekend: true })], now });
    expect(r[0]!.id).toBe('fit');
    expect(r[0]!.reasons).toEqual(expect.arrayContaining([expect.stringContaining('E14'), expect.stringContaining('ru'), expect.stringContaining('weekend')]));
  });
  it('caps B pool at 0.6', () => {
    const r = scoreSuppliers({ demand, suppliers: [sup({ id: 'b', pool: 'B', serviceArea: ['E14'], languages: ['ru'], isWeekend: true })], now });
    expect(r[0]!.score).toBeLessThanOrEqual(0.6);
  });
  it('excludes suppliers outside service area', () => {
    const r = scoreSuppliers({ demand, suppliers: [sup({ id: 'far', serviceArea: ['SW19'] })], now });
    expect(r).toEqual([]);
  });
  it('penalises stale verification', () => {
    const fresh = scoreSuppliers({ demand, suppliers: [sup({ id: 'a' })], now })[0]!.score;
    const stale = scoreSuppliers({ demand, suppliers: [sup({ id: 'a', lastVerifiedAt: new Date('2026-01-01') })], now })[0]!.score;
    expect(stale).toBeLessThan(fresh);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/matcher/tests/score-suppliers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/matcher/src/types.ts
export interface ScoredCandidate { id: string; kind: 'supplier' | 'supply'; score: number; reasons: string[] }
```

```ts
// packages/matcher/src/score-suppliers.ts
import type { Supplier } from '@matchbot/db';
import type { DemandDraft } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import type { ScoredCandidate } from './types.js';

const W = { area: 0.35, pool: 0.2, timing: 0.15, language: 0.15, price: 0.05, fresh: 0.1 } as const;
const B_POOL_CAP = 0.6;
const STALE_DAYS = 60;

function coversArea(area: string[], postcode: string | undefined): boolean {
  if (!postcode) return true; // 需求没给地点时不因区域排除，靠 agent 追问
  if (area.includes('LONDON')) return true;
  const pc = normalizePostcode(postcode);
  return !!pc && area.some((a) => a.toUpperCase() === pc.outward);
}
function isWeekend(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso).getUTCDay();
  return d === 0 || d === 6;
}
function isSoon(iso: string | undefined, now: Date): boolean {
  return !!iso && new Date(iso).getTime() - now.getTime() < 36 * 3600e3;
}

/** 确定性打分；分数 0–1，理由给审批卡和回复用（架构 §4.2）。 */
export function scoreSuppliers(p: { demand: DemandDraft; suppliers: Supplier[]; now: Date }): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  for (const s of p.suppliers) {
    if (s.category !== p.demand.category) continue;
    if (!coversArea(s.serviceArea, p.demand.fromPostcode)) continue;
    const reasons: string[] = [];
    let score = 0;
    if (p.demand.fromPostcode && !s.serviceArea.includes('LONDON')) { score += W.area; reasons.push(`covers ${p.demand.fromPostcode}`); } else { score += W.area * 0.5; }
    if (s.pool === 'A') { score += W.pool; reasons.push('verified partner'); }
    if (isWeekend(p.demand.whenAt) && s.isWeekend) { score += W.timing; reasons.push('works weekends'); }
    else if (isSoon(p.demand.whenAt, p.now) && s.isSameDay) { score += W.timing; reasons.push('same-day'); }
    else if (!p.demand.whenAt) { score += W.timing * 0.5; }
    if (p.demand.lang && s.languages.includes(p.demand.lang)) { score += W.language; reasons.push(`speaks ${p.demand.lang}`); }
    if (s.priceType === 'hourly' || s.priceType === 'fixed') { score += W.price; reasons.push(`${s.priceType} price known`); }
    const ageDays = s.lastVerifiedAt ? (p.now.getTime() - s.lastVerifiedAt.getTime()) / 86400e3 : Infinity;
    if (ageDays <= STALE_DAYS) { score += W.fresh; } else { reasons.push('verification stale'); }
    if (s.pool === 'B') score = Math.min(score, B_POOL_CAP);
    out.push({ id: s.id, kind: 'supplier', score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
```

`index.ts` re-export `types.js`、`score-suppliers.js`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/matcher/tests/score-suppliers.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/matcher
git commit -m "feat(matcher): deterministic supplier scoring"
```

---

### Task 2: scorePeerSupplies

**Files:**
- Create: `packages/matcher/src/score-peer-supplies.ts`
- Modify: `packages/matcher/src/index.ts`
- Test: `packages/matcher/tests/score-peer-supplies.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/matcher/tests/score-peer-supplies.test.ts
import { describe, expect, it } from 'vitest';
import { scorePeerSupplies } from '../src/score-peer-supplies.js';

const now = new Date('2026-09-25T10:00:00Z');
const supply = (over: Record<string, unknown>) => ({ id: 'p', category: 'man_and_van', area: 'E14', availability: 'Sunday', expiresAt: new Date('2026-09-30'), createdAt: now, userId: 'u', ...over }) as never;
const demand = { category: 'man_and_van' as const, confidence: 0.9, fromPostcode: 'E14', whenText: 'Sunday' };

describe('scorePeerSupplies', () => {
  it('prefers same area and overlapping availability text', () => {
    const r = scorePeerSupplies({ demand, supplies: [supply({ id: 'far', area: 'SW19' }), supply({ id: 'near' })], now });
    expect(r[0]!.id).toBe('near');
    expect(r[0]!.reasons).toContain('same area E14');
  });
  it('drops expired and other categories', () => {
    const r = scorePeerSupplies({ demand, supplies: [supply({ id: 'x', expiresAt: new Date('2026-09-01') }), supply({ id: 'y', category: 'eot_cleaning' })], now });
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/matcher/tests/score-peer-supplies.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/matcher/src/score-peer-supplies.ts
import type { Supply } from '@matchbot/db';
import type { DemandDraft } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import type { ScoredCandidate } from './types.js';

/** 群内同伴供给：信息少，只看品类、区域、时间文本重叠、新鲜度。分数上限 0.7，低于 A 池供应商。 */
export function scorePeerSupplies(p: { demand: DemandDraft; supplies: Supply[]; now: Date }): ScoredCandidate[] {
  const want = p.demand.fromPostcode ? normalizePostcode(p.demand.fromPostcode)?.outward : undefined;
  const out: ScoredCandidate[] = [];
  for (const s of p.supplies) {
    if (s.category !== p.demand.category || s.expiresAt.getTime() <= p.now.getTime()) continue;
    const reasons: string[] = [];
    let score = 0.2;
    const area = s.area ? normalizePostcode(s.area)?.outward : undefined;
    if (want && area && want === area) { score += 0.3; reasons.push(`same area ${want}`); }
    const a = (s.availability ?? '').toLowerCase();
    const w = (p.demand.whenText ?? '').toLowerCase();
    if (a && w && (a.includes(w) || w.includes(a))) { score += 0.15; reasons.push('availability matches'); }
    if (p.now.getTime() - s.createdAt.getTime() < 3 * 86400e3) { score += 0.05; reasons.push('posted recently'); }
    out.push({ id: s.id, kind: 'supply', score: Math.min(0.7, Math.round(score * 100) / 100), reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/matcher/tests/score-peer-supplies.test.ts`
Expected: 2 passed

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/matcher
git commit -m "feat(matcher): peer supply scoring"
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
