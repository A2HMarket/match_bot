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

- [x] **Step 1: 写失败测试**

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

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/eval/tests/replay.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

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

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/eval/tests/replay.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**（并行期间不跑 git，提交交给协调者 — AGENTS.md §9.2）

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

- [x] **Step 1: 写失败测试**

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

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/eval/tests/metrics.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

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

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/eval/tests/metrics.test.ts`
Expected: 1 passed

- [ ] **Step 5: 全量检查并提交**（本包已跑 `pnpm vitest run packages/eval` + 包内 tsc/eslint/prettier 全绿；全量 `pnpm check` 与提交由协调者在集成时串行执行 — AGENTS.md §9.2）

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
| 状态 | 代码与测试完成（`pnpm vitest run packages/eval` 14 passed；包内 tsc / eslint / prettier 全绿）。**一项阻塞**：入站门的 precision / recall / 沉默正确率无法在 `pnpm eval` 里算出，见下「阻塞」 |
| 执行者 | Claude（P12，与 P11 并行，未跑任何 git 命令） |
| PR | 未提交，由协调者串行合并（AGENTS.md §9.2） |
| 首次 `pnpm eval --live` 结果 | 2026-09-21，50 条标注集，`typesafe/jev-1.13-20260917`：`unavailable=0`、category accuracy **0.98**（唯一分歧 s39）、`is_demand` 正类 min **0.86** / 负类 max **0.11**、`is_supply` 正类 min 0.97 / 负类 max 0.76、p50 **343 ms** / p95 **645 ms**、**$0.00004644/条**（总 $0.002322）。用真实 `decideInbound + DEFAULT_THRESHOLDS` 对同一批 verdict 打分（一次性脚本，见「阻塞」）：**precision 1.00 / recall 1.00 / 沉默正确率 1.00 / category accuracy 0.98**，tp=27 fp=0 fn=0 tn=23，动作分布 `enter_agent 27 / drop 18 / tag_move_event 5` |
| 与 V4 基线一致性 | 一致。V4：precision 1.00、recall 1.00、category 0.98、p50 325 ms、$0.0000457/条、正类 min 0.86 / 负类 max 0.13。本轮 p95 645–787 ms 高于 V4 的 517 ms（纯网络抖动，仍是 2000 ms 预算的 1/3）；成本 +1.6%；唯一 category 分歧仍是那条乌克兰语「找到房子了、两周后搬」（s39），预测在 `other` / `housing` / `man_and_van` 之间跑间漂移，分歧出在标注本身 |
| 备注 | 见下 |

### 阻塞（需要协调者决定，本包按 AGENTS.md §9.2 未自行修改）

`packages/eval` 要跑真实入站门就得用 `@matchbot/gating` 的 `decideInbound` + `DEFAULT_THRESHOLDS`，但

1. `packages/eval/package.json` 没有声明 `@matchbot/gating`（运行时 `MODULE_NOT_FOUND`）；
2. `scripts/check-deps.mjs` 的 `ALLOWED['@matchbot/eval']` 也没列它 —— 而 AGENTS.md §3.2 的依赖链 `… ← { approval, agent } ← eval` 是允许 eval 依赖 gating 的，属于矩阵漏写（同样漏的还有 queue / matcher / channel-telegram / approval）。

两处都属于并行期间必须先报协调者的跨包改动，因此本包**没有**复制阈值或规则顶替（那会让 gating 与 eval 悄悄分叉，违反 AGENTS.md §4.4）。现在的处理：

- `replayInbound` / `scoreInbound` 把门作为参数注入（`decide` + `thresholds`，泛型不假设阈值结构），`decideInbound` 结构上直接可传；
- `src/gate.ts` 的 `loadInboundGate()` 暂时返回 `null`，注释里写了补依赖后要替换成的三行代码；
- `pnpm eval` 在门缺席时照常输出线上指标与不依赖门的回放结果（字段准确率、信号分离度、成本、延迟、模型版本），并以 error 级别显式报出这条阻塞，绝不静默降级。

**解阻塞只需两行**：`packages/eval/package.json` 的 dependencies 加 `"@matchbot/gating": "workspace:*"`，`scripts/check-deps.mjs` 的 `ALLOWED['@matchbot/eval']` 加 `'@matchbot/gating'`，然后按 `src/gate.ts` 注释改 `loadInboundGate()`。

### 与计划的偏差（AGENTS.md §9.1）

| 项 | 原计划 | 实际 | 为什么 |
|---|---|---|---|
| `replayInbound` 签名 | 直接 `import { decideInbound } from '@matchbot/gating'` | 门与阈值注入；另拆出 `evaluateSamples`（只跑 Jev）/ `scoreInbound`（只打分）/ `summarizeSignals`（无阈值分离度） | 上面的依赖阻塞；拆开后门缺席也能出字段准确率，且 Jev 调用与打分可分别测 |
| `thresholds` 参数 | 写死 `Thresholds` 8 个字段 | 泛型 `TThresholds`，eval 不认识字段名 | eval 不复制任何裸阈值（AGENTS.md §4.4）；`DEFAULT_THRESHOLDS` 原样传入即可 |
| 标注集字段 | `{ text, group, lang, is_demand, is_supply, category }` | 多 `id`（稳定键，回放 `inputRef=eval:<id>`、fixture 按 id 索引）与可选 `group_is_placeholder` | 见下「占位群名」 |
| CI 回放 | 计划只说「用 fixture」，没定形式 | `fixtures/jev-inbound.json` 录的是**原始 Jev 响应体**，经 `fetchImpl` 注入真实 `createJevClient` | 回放走生产同一条 zod 校验 / 降级路径，而不是平行实现；`src/record.ts` 负责重录 |
| 回放的成本 / 延迟 / 模型版本 | 计划没提 | 回放用内存版 `decision_traces`（`createMemoryTraces`）收留痕，再喂给同一个 `computeDailyMetrics` | AGENTS.md §3.3 第 2 条：指标只能来自 `decision_traces`；这样回放与线上是同一套聚合口径 |
| `computeDailyMetrics` | 只数 `jev` / `gate` / `agent_run` | 加 `rule`（P11 的黑名单丢弃写的是 `kind='rule'`）、`ruleOutcomes`、`jevLatencyP50/P95`、`jevUnavailable`、`jevModels` | 模型版本一变阈值全部作废（PoC V4 结论第 2 条），指标必须带版本；P11 的 `rule` 留痕不计入会漏掉入站漏斗第一层 |
| `gate` 留痕形状 | 只认 `output.outcome` | `output.outcome` 优先，回落 `output.gate` | `packages/agent` 的出站门与 `do_nothing` 写的是 `{ gate: 'outbound' }` / `{ gate: 'agent_noop' }`，只认 outcome 会全变成 `unknown` |
| `cli.ts` 输出 | `console.log` | pino logger（`createLogger('eval')`） | eslint `no-console` 在非测试文件是 error；AGENTS.md §5 也要求用 logger |
| `package.json` | 计划要求本任务改 | 未改（`pnpm eval` 脚本与 tsx 由协调者预先装好） | AGENTS.md §9.2 |

### 遗留问题

1. **`is_supply` 的阈值没有余量。** 本轮金标负类的 `is_supply` 最高到 **0.76–0.77**（俄语「找清洁工作」的求职消息），已经越过 `DEFAULT_THRESHOLDS.T_IS_SUPPLY_ENTER = 0.70`。这次没造成假阳**只是因为** `decideInbound` 先用 `isServiceCategory(category)` 把 `job` 挡掉了。PoC V4 建议的是 `T_IS_SUPPLY_RECORD = 0.80`，`packages/gating` 落的是 0.70 —— 建议协调者把它抬到 0.80（改阈值属于 gating，本包不动）。
2. **占位群名。** Brief §4 的群 seed 没有中文群，5 条中文样本仍用占位群名 `@london_chinese_life`（PRD §3 的华人社区群）。处理方式：字段 `group_is_placeholder: true` 显式标记，并有测试钉住「凡是这个群名就必须带标记」，避免它悄悄被当成真实语料。真接入中文群后替换群名与语料、去掉该字段、重跑 `src/record.ts`。**没有替换成别的群名**，因为换群名会改变 Jev 的 `state.group` 输入，直接让与 V4 的对照失效。
3. **样本品类仍偏斜**（22 条真需求里 11 条 `man_and_van`，`eot_cleaning` / `furniture_service` 各 5–6 条），本轮**刻意没有扩样本**：扩集会让与 V4 基线的逐项对照失效。Phase 0 有 Shadow 真实语料后再按 V4 的建议优先补这两类，并补 `has_location` / `is_move_event` / `urgency` 的人工标注（这两个阈值至今仍是无标注的暂定值）。
4. **`messagesEvaluated` 口径**：等于 `kind='jev'` 的留痕条数，Phase 2 出站评估也写 `kind='jev'`，届时这个数会把出站调用算进「评估过的消息数」。Phase 0 没有出站 Jev 调用，暂不影响；进 Phase 2 前需要在留痕里区分问题集（建议 P13 记一笔）。
5. `pnpm eval` 的线上指标目前是空库全 0（P11 还没跑出 Shadow 数据），只验证了链路通。
