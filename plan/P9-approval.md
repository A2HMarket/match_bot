# P9 approval 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把 `run_states` 里的中断快照发成运营群审批卡，把按钮回调变成 `approvals` 记录并入队 `resume_run`。

**Architecture:** 两个函数。`publishApproval` 读快照的 `interruptions` 渲染卡片并发送；`handleApprovalCallback` 解析回调、原子消费快照、写审批、入队。审批台 Phase 1 就是运营 Telegram 群（架构 D7）。

**Tech Stack:** TypeScript、vitest

**Spec:** `plan/interfaces.md` §approval；`docs/技术架构设计.md` §4.3 审批流程；`AGENTS.md` §3.3 第 6 条

## Global Constraints

- 快照消费必须走 `repos.runStates.consume`，返回 null 即忽略（重复点击、过期）。
- 审批人身份取 Telegram callback 的 `from.id`，不信任 callback_data 里的任何身份信息。
- 「改文案」不做按钮：运营手动在群里发并把需求标 `sent_manually`（Phase 2 再做）。

---

### Task 1: publishApproval

**Files:**
- Create: `packages/approval/src/publish.ts`
- Modify: `packages/approval/src/index.ts`
- Test: `packages/approval/tests/publish.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// packages/approval/tests/publish.test.ts
import { describe, expect, it, vi } from 'vitest';
import { publishApproval } from '../src/publish.js';

const runState = { id: 'rs1', userId: 'u', interruptions: [{ tool: 'reply_in_group', args: JSON.stringify({ text: '@Anna 3 options', supplierIds: ['a', 'b'] }) }] } as never;
describe('publishApproval', () => {
  it('renders supplier lines from repo and sends one card', async () => {
    const cards = { sendApprovalCard: vi.fn(async () => ({ messageId: '9' })) };
    const repos = { suppliers: { findByIds: vi.fn(async () => [{ id: 'a', name: 'Van Co', roughPrice: '£40/h', pool: 'A' }, { id: 'b', name: 'Move Ltd', roughPrice: null, pool: 'B' }]) }, demands: { findOpenByUser: vi.fn(async () => [{ category: 'man_and_van', confidence: 0.94 }]) } } as never;
    await publishApproval({ repos, cards: cards as never, runState });
    expect(cards.sendApprovalCard).toHaveBeenCalledWith(expect.objectContaining({ runStateId: 'rs1', draftText: '@Anna 3 options', supplierLines: ['1. Van Co £40/h (A)', '2. Move Ltd (B)'], confidence: 0.94 }));
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/approval/tests/publish.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/approval/src/publish.ts
import type { createOpsCardSender } from '@matchbot/channel-telegram';
import type { Repositories, RunState } from '@matchbot/db';
import { z } from 'zod';

const interruptionSchema = z.object({ tool: z.string(), args: z.string() });
const replyArgs = z.object({ text: z.string(), supplierIds: z.array(z.string()).default([]) });

export async function publishApproval(p: { repos: Repositories; cards: ReturnType<typeof createOpsCardSender>; runState: RunState }): Promise<void> {
  const interruptions = z.array(interruptionSchema).parse(p.runState.interruptions);
  const first = interruptions[0];
  if (!first) return;
  const args = replyArgs.safeParse(JSON.parse(first.args));
  const text = args.success ? args.data.text : first.args;
  const ids = args.success ? args.data.supplierIds : [];
  const suppliers = ids.length ? await p.repos.suppliers.findByIds(ids) : [];
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const supplierLines = ids.map((id, i) => { const s = byId.get(id); return s ? `${i + 1}. ${s.name}${s.roughPrice ? ` ${s.roughPrice}` : ''} (${s.pool})` : `${i + 1}. ${id} (unknown)`; });
  const demand = (await p.repos.demands.findOpenByUser(p.runState.userId))[0];
  await p.cards.sendApprovalCard({
    runStateId: p.runState.id,
    title: `${first.tool} · ${demand?.category ?? 'unknown'}`,
    draftText: text,
    supplierLines,
    confidence: demand?.confidence ?? 0,
  });
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/approval/tests/publish.test.ts`
Expected: 1 passed

- [x] **Step 5: Commit**

```bash
git add packages/approval
git commit -m "feat(approval): publish approval card to ops group"
```

---

### Task 2: handleApprovalCallback

**Files:**
- Create: `packages/approval/src/callback.ts`
- Modify: `packages/approval/src/index.ts`
- Test: `packages/approval/tests/callback.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// packages/approval/tests/callback.test.ts
import { describe, expect, it, vi } from 'vitest';
import { handleApprovalCallback } from '../src/callback.js';

function deps(consumeResult: unknown) {
  return {
    repos: { runStates: { consume: vi.fn(async () => consumeResult) }, approvals: { create: vi.fn(async () => ({ id: 'ap1' })) } },
    queues: {},
    enqueueResume: vi.fn(async () => {}),
  };
}
describe('handleApprovalCallback', () => {
  it('approve: consumes, records, enqueues', async () => {
    const d = deps({ id: 'rs1' });
    expect(await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:approve' } as never)).toBe('queued');
    expect(d.repos.approvals.create).toHaveBeenCalledWith({ runStateId: 'rs1', reviewer: '555', decision: 'approve' });
    expect(d.enqueueResume).toHaveBeenCalledWith({}, { runStateId: 'rs1', approvalId: 'ap1' });
  });
  it('ignore: consumes and records, does not enqueue', async () => {
    const d = deps({ id: 'rs1' });
    expect(await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:ignore' } as never)).toBe('ignored');
    expect(d.enqueueResume).not.toHaveBeenCalled();
  });
  it('already consumed -> ignored without writing', async () => {
    const d = deps(null);
    expect(await handleApprovalCallback({ ...d, reviewer: '555', data: 'apv:rs1:approve' } as never)).toBe('ignored');
    expect(d.repos.approvals.create).not.toHaveBeenCalled();
  });
  it('garbage -> invalid', async () => {
    expect(await handleApprovalCallback({ ...deps(null), reviewer: '555', data: 'nope' } as never)).toBe('invalid');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/approval/tests/callback.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// packages/approval/src/callback.ts
import { parseApprovalCallback } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import { enqueueResume as defaultEnqueueResume, type Queues } from '@matchbot/queue';

/** 原子消费快照后才写审批与入队（AGENTS.md §3.3 第 6 条）。reject 也要恢复 run，让模型收到拒绝反馈并结束。 */
export async function handleApprovalCallback(p: { repos: Repositories; queues: Queues; reviewer: string; data: string; enqueueResume?: typeof defaultEnqueueResume }): Promise<'queued' | 'ignored' | 'invalid'> {
  const parsed = parseApprovalCallback(p.data);
  if (!parsed) return 'invalid';
  const rs = await p.repos.runStates.consume(parsed.runStateId);
  if (!rs) return 'ignored';
  const approval = await p.repos.approvals.create({ runStateId: rs.id, reviewer: p.reviewer, decision: parsed.decision });
  if (parsed.decision === 'ignore') return 'ignored';
  await (p.enqueueResume ?? defaultEnqueueResume)(p.queues, { runStateId: rs.id, approvalId: approval.id });
  return 'queued';
}
```

`index.ts` re-export `publish.js`、`callback.js`。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/approval/tests/callback.test.ts`
Expected: 4 passed

- [x] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/approval
git commit -m "feat(approval): handle approval callbacks with atomic snapshot consumption"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | 完成（待合并 main，并行期间合并由协调者执行） |
| 执行者 | kimi |
| PR | `feat/P9-approval`（8b0c6ea + 60f8390，基于 main 5e252fe） |
| 与 interfaces.md 的偏差 | 无。签名与 §approval 一致；依赖包（db / queue / channel-telegram）实际签名与契约一致 |
| 备注 | 见下 |

### 偏差与说明

- **测试比计划多 2 条**：`publishApproval` 增加「无 interruptions 不发卡」用例；`handleApprovalCallback` 增加「reject 也入队 resume」用例（对应实现注释：拒绝也要恢复 run 让模型收到反馈并结束，计划代码本就如此，但计划测试未覆盖）。
- **测试 mock 写法**：用 `vi.fn().mockResolvedValue(...)` 替代计划里的 `async () => ...`，否则 eslint `require-await` 报错；去掉 `cards as never`（`no-unnecessary-type-assertion`）。
- **检查结果**：`packages/approval` 的 typecheck / eslint / prettier / vitest 全绿（7 个用例通过），`check-deps.mjs` 通过。全仓 `pnpm check` 当前被 `apps/bot`（P10 并行 WIP）的 lint/type 错误阻断，与 P9 无关。
- **git 事故记录**：并行 agent（P10）在同一工作树切到 `feat/P10-app-bot`（其分支基于 `feat/P9-approval` 8b0c6ea），导致 Task 2 提交 1d6181c 落在对方分支上。已用 plumbing 在 `feat/P9-approval` 上重建等价提交 60f8390（父为 8b0c6ea，内容与 1d6181c 的 approval 部分逐字节一致）；1d6181c 留在 P10 分支无害（内容相同，合并时不冲突），但其分支指针未被改动，避免干扰对方工作区。
