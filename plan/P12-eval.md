# P12 eval 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 `decision_traces` 与标注样本算出 PRD §9 的指标，并能离线回放入站门。

**Architecture:** `metrics.ts` 纯 SQL 聚合（经 repos）；`replay.ts` 拿标注样本重跑 `evaluateInbound + decideInbound`（真实 Jev 或 fixture）；`cli.ts` 一个命令 `pnpm eval`。标注样本来自 PoC V4 的 `labeled.json`，扩到 ≥ 50 条。

**Tech Stack:** TypeScript、vitest

**Spec:** PRD §9；`docs/技术架构设计.md` §8；`AGENTS.md` §7 评测行

## Global Constraints

- 回放时出站一律不执行（只跑到入站门与 agent dry-run）。
- CI 里回放用 fixture，不打真实 Jev；手动 `pnpm eval --live` 才联网。

---

### Task 1: 标注样本与回放

**Files:**
- Create: `packages/eval/fixtures/labeled-inbound.json`（≥ 50 条：`{ text, group, lang, is_demand, is_supply, category }`）
- Create: `packages/eval/src/replay.ts`
- Test: `packages/eval/tests/replay.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/eval/tests/replay.test.ts
import { describe, expect, it, vi } from 'vitest';
import { replayInbound } from '../src/replay.js';

describe('replayInbound', () => {
  it('computes precision/recall/category accuracy against labels', async () => {
    const samples = [
      { text: 'need a van', group: 'g', is_demand: true, is_supply: false, category: 'man_and_van' },
      { text: 'lol', group: 'g', is_demand: false, is_supply: false, category: 'other' },
    ];
    const evaluateInbound = vi.fn(async (_c: unknown, p: { text: string }) => p.text === 'need a van'
      ? { ok: true, isDemand: 0.9, isSupply: 0, category: 'man_and_van', categoryConfidence: 0.9, urgency: 0, hasLocation: 0, isSensitive: 0, isMoveEvent: 0 }
      : { ok: true, isDemand: 0.1, isSupply: 0, category: 'other', categoryConfidence: 0.9, urgency: 0, hasLocation: 0, isSensitive: 0, isMoveEvent: 0 });
    const r = await replayInbound({ samples: samples as never, evaluateInbound: evaluateInbound as never, jev: {} as never, thresholds: { T_IS_DEMAND_ENTER: 0.7, T_IS_SUPPLY_ENTER: 0.7, T_IS_SENSITIVE_DROP: 0.5, T_IS_MOVE_EVENT_TAG: 0.6, T_WORTH_REPLYING_AUTO: 2.2, T_LANGUAGE_OK_AUTO: 0.8, T_MENTIONS_UNVERIFIED_DROP: 0.5, T_WORTH_REPLYING_DROP: 1 } });
    expect(r).toMatchObject({ n: 2, precision: 1, recall: 1, categoryAccuracy: 1, silenceCorrect: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/eval/tests/replay.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/eval/src/replay.ts
import type { DemandCategory } from '@matchbot/domain';
import { decideInbound, type Thresholds } from '@matchbot/gating';
import type { JevClient, evaluateInbound as evaluateInboundFn } from '@matchbot/jev';

export interface LabeledSample { text: string; group: string; lang?: string; is_demand: boolean; is_supply: boolean; category: DemandCategory }
export interface ReplayReport { n: number; precision: number; recall: number; categoryAccuracy: number; silenceCorrect: number; unavailable: number; rows: Array<{ text: string; expected: boolean; predicted: boolean; category: string; expectedCategory: string }> }

/** PRD §9：Intent precision、字段准确率、沉默正确率。silenceCorrect = 未进 agent 的样本中确实不该进的比例。 */
export async function replayInbound(p: { samples: LabeledSample[]; evaluateInbound: typeof evaluateInboundFn; jev: JevClient; thresholds: Thresholds }): Promise<ReplayReport> {
  let tp = 0, fp = 0, fn = 0, catOk = 0, silent = 0, silentCorrect = 0, unavailable = 0;
  const rows: ReplayReport['rows'] = [];
  for (const s of p.samples) {
    const v = await p.evaluateInbound(p.jev, { text: s.text, groupName: s.group, lang: s.lang, recentTexts: [], inputRef: `eval:${s.text.slice(0, 20)}`, phase: 0 });
    if (!v.ok) { unavailable++; continue; }
    const d = decideInbound(v, p.thresholds);
    const predicted = d.action === 'enter_agent';
    const expected = s.is_demand || s.is_supply;
    if (predicted && expected) tp++; else if (predicted && !expected) fp++; else if (!predicted && expected) fn++;
    if (!predicted) { silent++; if (!expected) silentCorrect++; }
    if (v.category === s.category) catOk++;
    rows.push({ text: s.text, expected, predicted, category: v.category, expectedCategory: s.category });
  }
  const n = p.samples.length - unavailable;
  const safe = (a: number, b: number) => (b === 0 ? 1 : a / b);
  return { n, precision: safe(tp, tp + fp), recall: safe(tp, tp + fn), categoryAccuracy: safe(catOk, n), silenceCorrect: safe(silentCorrect, silent), unavailable, rows };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/eval/tests/replay.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add packages/eval
git commit -m "feat(eval): inbound replay against labeled samples"
```

---

### Task 2: 线上指标与 CLI

**Files:**
- Create: `packages/eval/src/metrics.ts`、`packages/eval/src/cli.ts`
- Modify: `packages/eval/package.json`（`"bin"` 或 script `eval`），根 `package.json` 加 `"eval": "pnpm --filter @matchbot/eval run eval"`
- Test: `packages/eval/tests/metrics.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/eval/tests/metrics.test.ts
import { describe, expect, it, vi } from 'vitest';
import { computeDailyMetrics } from '../src/metrics.js';

describe('computeDailyMetrics', () => {
  it('derives density, cost and outcome counts from traces', async () => {
    const traces = {
      listByKind: vi.fn(async (kind: string) => kind === 'gate'
        ? [{ output: { outcome: 'entered_agent' }, costMicro: 0 }, { output: { outcome: 'dropped_by_jev' }, costMicro: 0 }, { output: { outcome: 'agent_interrupted' }, costMicro: 0 }]
        : kind === 'jev' ? [{ output: {}, costMicro: 17 }, { output: {}, costMicro: 17 }] : kind === 'agent_run' ? [{ output: {}, costMicro: 900 }] : []),
    };
    const m = await computeDailyMetrics({ traces: traces as never, since: new Date(0) });
    expect(m).toMatchObject({ messagesEvaluated: 2, enteredAgent: 1, interrupted: 1, costMicroTotal: 934 });
    expect(m.costMicroPer1000Messages).toBe(467000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/eval/tests/metrics.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/eval/src/metrics.ts
import type { Repositories } from '@matchbot/db';

export interface DailyMetrics { messagesEvaluated: number; enteredAgent: number; interrupted: number; dryRuns: number; costMicroTotal: number; costMicroPer1000Messages: number; outcomes: Record<string, number> }

/** PRD §9 的数据来源只有 decision_traces（AGENTS.md §3.3 第 2 条）。 */
export async function computeDailyMetrics(p: { traces: Repositories['traces']; since: Date }): Promise<DailyMetrics> {
  const [jev, gate, agent] = await Promise.all([p.traces.listByKind('jev', p.since, 100000), p.traces.listByKind('gate', p.since, 100000), p.traces.listByKind('agent_run', p.since, 100000)]);
  const outcomes: Record<string, number> = {};
  for (const g of gate) { const o = (g.output as { outcome?: string }).outcome ?? 'unknown'; outcomes[o] = (outcomes[o] ?? 0) + 1; }
  const costMicroTotal = [...jev, ...gate, ...agent].reduce((a, t) => a + t.costMicro, 0);
  const messagesEvaluated = jev.length;
  return {
    messagesEvaluated, enteredAgent: outcomes.entered_agent ?? 0, interrupted: outcomes.agent_interrupted ?? 0, dryRuns: outcomes.agent_completed ?? 0,
    costMicroTotal, costMicroPer1000Messages: messagesEvaluated ? Math.round((costMicroTotal / messagesEvaluated) * 1000) : 0, outcomes,
  };
}
```

```ts
// packages/eval/src/cli.ts
import { createRepositories, getPrisma } from '@matchbot/db';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createJevClient, evaluateInbound } from '@matchbot/jev';
import { createLogger, loadEnv } from '@matchbot/shared';
import { readFileSync } from 'node:fs';
import { computeDailyMetrics } from './metrics.js';
import { replayInbound, type LabeledSample } from './replay.js';

const env = loadEnv();
const repos = createRepositories(getPrisma(env.DATABASE_URL));
const live = process.argv.includes('--live');
const metrics = await computeDailyMetrics({ traces: repos.traces, since: new Date(Date.now() - 86400e3) });
console.log('last 24h:', JSON.stringify(metrics, null, 2));
if (live) {
  const samples = JSON.parse(readFileSync(new URL('../fixtures/labeled-inbound.json', import.meta.url), 'utf8')) as LabeledSample[];
  const jev = createJevClient({ baseUrl: env.JEV_BASE_URL, apiKey: env.JEV_API_KEY, model: env.JEV_MODEL, traces: repos.traces, logger: createLogger('eval') });
  const r = await replayInbound({ samples, evaluateInbound, jev, thresholds: DEFAULT_THRESHOLDS });
  console.log(`replay: n=${r.n} precision=${r.precision.toFixed(2)} recall=${r.recall.toFixed(2)} category=${r.categoryAccuracy.toFixed(2)} silence=${r.silenceCorrect.toFixed(2)} unavailable=${r.unavailable}`);
}
```

`packages/eval/package.json` scripts 加 `"eval": "tsx src/cli.ts"`，devDependencies 加 tsx。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/eval/tests/metrics.test.ts`
Expected: 1 passed

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check && pnpm eval`
Expected: 全绿；`pnpm eval` 打印 24h 指标（空库时全 0）

```bash
git add packages/eval package.json
git commit -m "feat(eval): daily metrics and eval cli"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | |
| 执行者 | |
| PR | |
| 首次 `pnpm eval --live` 结果 | |
| 备注 | |
