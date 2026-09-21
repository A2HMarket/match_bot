# P11 apps/worker 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把所有包串成一条消息的完整旅程：入站 job → 代码门 → Jev 入站门 → agent → 快照/审批 → resume job，加上 cron。

**Architecture:** `pipeline/inbound.ts` 是架构 §3 流程图的直译，每个分支写一条 `decision_traces`；`pipeline/resume.ts` 消费 `resume_run`；`cron.ts` 注册 repeatable job。`main.ts` 装配三个 worker。端到端 smoke test 用 stub 模型跑通"群消息 → dry-run 出站行"。

**Tech Stack:** BullMQ（经 `@matchbot/queue`）、全部 packages

**Spec:** `docs/技术架构设计.md` §3、§7、§9；`plan/interfaces.md`

## Global Constraints

- 流程图每个终点都要留痕：`dropped_by_rule`、`dropped_by_jev`、`tagged_move_event`、`entered_agent`、`agent_interrupted`、`agent_completed`（AGENTS.md §3.3 第 2 条）。
- Jev 不可用 → 不进 agent（AGENTS.md §3.3 第 5 条）。
- 同一用户的 run 串行：inbound worker 用 `userId` 做 BullMQ group/锁（简单做法：`concurrency: 1` 起步，Phase 2 再优化）。

---

### Task 1: inbound pipeline

**Files:**
- Create: `apps/worker/src/pipeline/inbound.ts`
- Create: `apps/worker/src/deps.ts`（装配 `AgentDeps` 与 pipeline 依赖）
- Test: `apps/worker/tests/pipeline/inbound.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// apps/worker/tests/pipeline/inbound.test.ts
import { describe, expect, it, vi } from 'vitest';
import { processInbound } from '../../src/pipeline/inbound.js';

const msg = { channel: 'telegram' as const, chatId: '-1', messageId: '5', userId: '42', text: 'need a van E14 to SE1 sunday', receivedAt: new Date().toISOString() };
function deps(over: Record<string, unknown> = {}) {
  const traces = { create: vi.fn(async () => ({})) };
  return {
    env: { DEFAULT_PHASE: 0 },
    repos: {
      traces,
      users: { upsertByExternal: vi.fn(async () => ({ id: 'u1' })) },
      groups: { findByExternal: vi.fn(async () => ({ id: 'g1', name: 'G', phase: 0, isActive: true })) },
      messages: { create: vi.fn(async () => ({ id: 'm1' })), recentByUser: vi.fn(async () => []) },
      demands: { findOpenByUser: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'd1' })) },
    },
    evaluateInbound: vi.fn(async () => ({ ok: true, isDemand: 0.9, isSupply: 0.1, category: 'man_and_van', categoryConfidence: 0.9, urgency: 3, hasLocation: 0.9, isSensitive: 0, isMoveEvent: 0.1 })),
    runInbound: vi.fn(async () => ({ kind: 'completed', toolsCalled: ['upsert_demand', 'reply_in_group'] })),
    publishApproval: vi.fn(async () => {}),
    thresholds: { T_IS_DEMAND_ENTER: 0.7, T_IS_SUPPLY_ENTER: 0.7, T_IS_SENSITIVE_DROP: 0.5, T_IS_MOVE_EVENT_TAG: 0.6, T_WORTH_REPLYING_AUTO: 2.2, T_LANGUAGE_OK_AUTO: 0.8, T_MENTIONS_UNVERIFIED_DROP: 0.5, T_WORTH_REPLYING_DROP: 1.0 },
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over,
  } as never;
}

describe('processInbound', () => {
  it('blacklisted text is dropped by rule, jev never called', async () => {
    const d = deps();
    await processInbound(d, { ...msg, text: '有人换汇吗' });
    expect((d as { evaluateInbound: ReturnType<typeof vi.fn> }).evaluateInbound).not.toHaveBeenCalled();
    expect((d as { repos: { traces: { create: ReturnType<typeof vi.fn> } } }).repos.traces.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rule', output: expect.objectContaining({ outcome: 'dropped_by_rule' }) }));
  });
  it('service demand enters agent with user-scoped context', async () => {
    const d = deps();
    await processInbound(d, msg);
    const run = (d as { runInbound: ReturnType<typeof vi.fn> }).runInbound;
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ userId: 'u1', chatId: '-1', phase: 0, sourceMessageId: 'm1' }), input: msg.text }));
  });
  it('jev unavailable -> no agent', async () => {
    const d = deps({ evaluateInbound: vi.fn(async () => ({ ok: false, reason: 'timeout' })) });
    await processInbound(d, msg);
    expect((d as { runInbound: ReturnType<typeof vi.fn> }).runInbound).not.toHaveBeenCalled();
  });
  it('interrupted run publishes approval', async () => {
    const d = deps({ runInbound: vi.fn(async () => ({ kind: 'interrupted', runStateId: 'rs1' })), repos: { ...(deps() as { repos: object }).repos, runStates: { findById: vi.fn(async () => ({ id: 'rs1' })) } } });
    await processInbound(d, msg);
    expect((d as { publishApproval: ReturnType<typeof vi.fn> }).publishApproval).toHaveBeenCalled();
  });
});
```

（`repos.runStates.findById` 已在 interfaces.md §db 与 P2 中。）

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/worker/tests/pipeline/inbound.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// apps/worker/src/pipeline/inbound.ts
import type { publishApproval as publishApprovalFn } from '@matchbot/approval';
import type { AgentDeps, MatchContext, runInbound as runInboundFn } from '@matchbot/agent';
import type { InboundMessage } from '@matchbot/domain';
import { decideInbound, isBlacklisted, resolvePhase } from '@matchbot/gating';
import type { evaluateInbound as evaluateInboundFn } from '@matchbot/jev';

export interface PipelineDeps extends AgentDeps {
  evaluateInbound: typeof evaluateInboundFn;
  runInbound: typeof runInboundFn;
  publishApproval: typeof publishApprovalFn;
  cards: Parameters<typeof publishApprovalFn>[0]['cards'];
}

/** 架构 §3 流程图的直译。每个终点一条 trace。 */
export async function processInbound(d: PipelineDeps, msg: InboundMessage): Promise<void> {
  const t0 = Date.now();
  const user = await d.repos.users.upsertByExternal({ channel: msg.channel, externalId: msg.userId, lang: msg.lang });
  const group = msg.chatId === msg.userId ? null : await d.repos.groups.findByExternal(msg.channel, msg.chatId);
  const phase = resolvePhase({ group, defaultPhase: d.env.DEFAULT_PHASE as 0 | 1 | 2 });
  const stored = await d.repos.messages.create({ groupId: group?.id ?? null, userId: user.id, externalId: msg.messageId, text: msg.text, lang: msg.lang, receivedAt: new Date(msg.receivedAt) });
  const trace = (kind: 'rule' | 'gate', output: unknown) => d.repos.traces.create({ kind, inputRef: stored.id, output, phase, latencyMs: Date.now() - t0, costMicro: 0 });

  if (isBlacklisted(msg.text)) { await trace('rule', { outcome: 'dropped_by_rule', reason: 'blacklist' }); return; }

  const recent = (await d.repos.messages.recentByUser(user.id, 24)).filter((m) => m.id !== stored.id).map((m) => m.text).slice(0, 5);
  const v = await d.evaluateInbound(d.jev, { text: msg.text, groupName: group?.name ?? 'private', lang: msg.lang, recentTexts: recent, inputRef: stored.id, phase });
  if (!v.ok) { await trace('gate', { outcome: 'dropped_by_jev', reason: v.reason }); return; }

  const decision = decideInbound(v, d.thresholds);
  if (decision.action === 'drop') { await trace('gate', { outcome: 'dropped_by_jev', reason: decision.reason, verdict: v }); return; }
  if (decision.action === 'tag_move_event') {
    await d.repos.demands.create({ userId: user.id, category: v.category, confidence: v.categoryConfidence, sourceMessageId: stored.id, isMoveEvent: true });
    await trace('gate', { outcome: 'tagged_move_event', verdict: v });
    return;
  }

  const open = (await d.repos.demands.findOpenByUser(user.id)).find((x) => x.category === decision.category);
  const ctx: MatchContext = {
    userId: user.id, chatId: msg.chatId, groupId: group?.id ?? null, phase, sourceMessageId: stored.id, recentReplies: [],
    ...(open ? { demandId: open.id, demand: { category: open.category, confidence: open.confidence, fromPostcode: open.fromPostcode ?? undefined, toPostcode: open.toPostcode ?? undefined, whenText: open.whenText ?? undefined, lang: open.lang ?? undefined } } : {}),
  };
  await trace('gate', { outcome: 'entered_agent', decision, verdict: v });
  const r = await d.runInbound({ deps: d, ctx, input: msg.text });
  if (r.kind === 'interrupted') {
    const rs = await d.repos.runStates.findById(r.runStateId);
    if (rs) await d.publishApproval({ repos: d.repos, cards: d.cards, runState: rs });
    await trace('gate', { outcome: 'agent_interrupted', runStateId: r.runStateId });
  } else {
    await trace('gate', { outcome: 'agent_completed', toolsCalled: r.toolsCalled });
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/worker/tests/pipeline/inbound.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**（并行约定：提交由协调者串行完成，本 agent 未跑任何 git 命令）

```bash
git add apps/worker plan/interfaces.md
git commit -m "feat(worker): inbound pipeline"
```

---

### Task 2: resume pipeline 与 cron

**Files:**
- Create: `apps/worker/src/pipeline/resume.ts`、`apps/worker/src/cron.ts`
- Test: `apps/worker/tests/pipeline/resume.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// apps/worker/tests/pipeline/resume.test.ts
import { describe, expect, it, vi } from 'vitest';
import { processResume } from '../../src/pipeline/resume.js';

describe('processResume', () => {
  it('loads run state + approval and calls resumeRun with user context', async () => {
    const d = {
      env: { DEFAULT_PHASE: 1 },
      repos: { runStates: { findById: vi.fn(async () => ({ id: 'rs1', userId: 'u1', status: 'consumed' })) }, approvals: { findById: vi.fn(async () => ({ id: 'ap1', decision: 'approve' })) }, demands: { findOpenByUser: vi.fn(async () => []) }, traces: { create: vi.fn(async () => ({})) } },
      resumeRun: vi.fn(async () => ({ kind: 'completed', toolsCalled: ['reply_in_group'] })),
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;
    await processResume(d, { runStateId: 'rs1', approvalId: 'ap1' });
    expect((d as { resumeRun: ReturnType<typeof vi.fn> }).resumeRun).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ userId: 'u1' }) }));
  });
});
```

（`repos.approvals.findById` 已在 interfaces.md 与 P2 中。）

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/worker/tests/pipeline/resume.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
// apps/worker/src/pipeline/resume.ts
import type { AgentDeps, resumeRun as resumeRunFn } from '@matchbot/agent';

export async function processResume(d: AgentDeps & { resumeRun: typeof resumeRunFn }, job: { runStateId: string; approvalId: string }): Promise<void> {
  const rs = await d.repos.runStates.findById(job.runStateId);
  const approval = await d.repos.approvals.findById(job.approvalId);
  if (!rs || !approval) { d.logger.warn(job, 'resume: missing run state or approval'); return; }
  const open = (await d.repos.demands.findOpenByUser(rs.userId))[0];
  const ctx = { userId: rs.userId, chatId: '', groupId: null, phase: d.env.DEFAULT_PHASE as 0 | 1 | 2, sourceMessageId: rs.id, recentReplies: [], ...(open ? { demandId: open.id, demand: { category: open.category, confidence: open.confidence } } : {}) };
  const r = await d.resumeRun({ deps: d, runState: rs, approval, ctx });
  await d.repos.traces.create({ kind: 'gate', inputRef: rs.id, output: { outcome: r.kind === 'completed' ? 'resume_completed' : 'resume_interrupted', ...r }, phase: ctx.phase, latencyMs: 0, costMicro: 0 });
}
```

`run_states` 已有 `chatId` 与 `phase` 列（interfaces.md §db），P8 的 `settle()` 写入；这里用 `chatId: rs.chatId, phase: rs.phase` 替换上面的 `chatId: ''` 与 `d.env.DEFAULT_PHASE`。**不得留空字符串。**

```ts
// apps/worker/src/cron.ts
import type { Repositories } from '@matchbot/db';
import { QUEUE_NAMES, type Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';

export const CRON_JOBS = {
  redactMessages: { name: 'redact_messages', every: 6 * 3600e3 },
  expireDemands: { name: 'expire_demands', every: 24 * 3600e3 },
  expireRunStates: { name: 'expire_run_states', every: 3600e3 },
} as const;

export async function scheduleCron(q: Queues): Promise<void> {
  for (const j of Object.values(CRON_JOBS)) await q.cron.add(j.name, {}, { repeat: { every: j.every }, jobId: `cron:${j.name}` });
}

export async function runCronJob(name: string, repos: Repositories, logger: Logger): Promise<void> {
  switch (name) {
    case CRON_JOBS.redactMessages.name: logger.info({ n: await repos.messages.redactOlderThan(30) }, 'redacted messages'); break;
    case CRON_JOBS.expireDemands.name: logger.info({ n: await repos.demands.expireOlderThan(14) }, 'expired demands'); break;
    case CRON_JOBS.expireRunStates.name: logger.info({ n: await repos.runStates.expireOld(new Date()) }, 'expired run states'); break;
    default: logger.warn({ name }, 'unknown cron job');
  }
}
void QUEUE_NAMES;
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/worker/tests/pipeline/resume.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**（并行约定：提交由协调者串行完成，本 agent 未跑任何 git 命令）

```bash
git add apps/worker packages/db plan/interfaces.md
git commit -m "feat(worker): resume pipeline and cron jobs"
```

---

### Task 3: main.ts 装配与端到端 smoke

**Files:**
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/deps.ts`
- Test: `apps/worker/tests/e2e/shadow.test.ts`

- [x] **Step 1: 装配**

```ts
// apps/worker/src/deps.ts
import { publishApproval } from '@matchbot/approval';
import { configureModelProvider, createTraceProcessor, resumeRun, runInbound } from '@matchbot/agent';
import { createOpsCardSender } from '@matchbot/channel-telegram';
import { createRepositories, getPrisma } from '@matchbot/db';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createJevClient, evaluateInbound, evaluateOutbound } from '@matchbot/jev';
import { createLogger, loadEnv, type Env } from '@matchbot/shared';
import { Bot } from 'grammy';
import type { PipelineDeps } from './pipeline/inbound.js';

export function buildDeps(env: Env = loadEnv()): PipelineDeps & { resumeRun: typeof resumeRun } {
  const logger = createLogger('worker', env.LOG_LEVEL);
  const repos = createRepositories(getPrisma(env.DATABASE_URL));
  configureModelProvider(env, [createTraceProcessor({ traces: repos.traces, phase: () => env.DEFAULT_PHASE as 0 | 1 | 2 })]);
  const jev = createJevClient({ baseUrl: env.JEV_BASE_URL, apiKey: env.JEV_API_KEY, model: env.JEV_MODEL, traces: repos.traces, logger });
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return { env, repos, jev, thresholds: DEFAULT_THRESHOLDS, logger, evaluateOutbound, evaluateInbound, runInbound, resumeRun, publishApproval, cards: createOpsCardSender({ bot, opsChatId: env.TELEGRAM_OPS_CHAT_ID }) };
}
```

```ts
// apps/worker/src/main.ts
import { QUEUE_NAMES, createQueues, createWorker } from '@matchbot/queue';
import { runCronJob, scheduleCron } from './cron.js';
import { buildDeps } from './deps.js';
import { processInbound } from './pipeline/inbound.js';
import { processResume } from './pipeline/resume.js';

const d = buildDeps();
const queues = createQueues(d.env.REDIS_URL);
await scheduleCron(queues);
const workers = [
  createWorker(QUEUE_NAMES.inbound, d.env.REDIS_URL, (m) => processInbound(d, m as never), { concurrency: 1 }),
  createWorker(QUEUE_NAMES.resume, d.env.REDIS_URL, (j) => processResume(d, j as never), { concurrency: 1 }),
  createWorker(QUEUE_NAMES.cron, d.env.REDIS_URL, (_data, jobName) => runCronJob(jobName, d.repos, d.logger), { concurrency: 1 }),
];
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void Promise.all(workers.map((w) => w.close())); });
d.logger.info({ phase: d.env.DEFAULT_PHASE }, 'worker started');
```

- [x] **Step 2: 端到端 smoke（stub 模型，真实 Postgres/Redis）**

```ts
// apps/worker/tests/e2e/shadow.test.ts
// 真实 Postgres + 真实 repos；Jev 与模型用 stub。不回滚，用唯一前缀并在 afterAll 清理。
import { createRepositories, getPrisma } from '@matchbot/db';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { processInbound } from '../../src/pipeline/inbound.js';
import { textResponse, toolCallResponse } from '@matchbot/agent/tests/helpers/model-stub.js';
import { runInbound } from '@matchbot/agent';

const prisma = getPrisma(process.env.DATABASE_URL ?? 'postgresql://matchbot:matchbot@localhost:5432/matchbot');
const repos = createRepositories(prisma);
const PREFIX = `e2e-${Date.now()}`;

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { externalId: { startsWith: PREFIX } } });
  const ids = users.map((u) => u.id);
  await prisma.decisionTrace.deleteMany({ where: { inputRef: { in: (await prisma.message.findMany({ where: { userId: { in: ids } } })).map((m) => m.id) } } });
  await prisma.outboundMessage.deleteMany({ where: { target: `${PREFIX}-chat` } });
  await prisma.match.deleteMany({ where: { demand: { userId: { in: ids } } } });
  await prisma.demand.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sessionItem.deleteMany({ where: { userId: { in: ids } } });
  await prisma.message.deleteMany({ where: { userId: { in: ids } } });
  await prisma.group.deleteMany({ where: { externalId: `${PREFIX}-chat` } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe('shadow e2e', () => {
  it('group message ends as a dry_run outbound row and leaves rule/jev/gate/agent_run traces', async () => {
    await repos.groups.upsert({ channel: 'telegram', externalId: `${PREFIX}-chat`, name: 'e2e' });
    await prisma.group.update({ where: { channel_externalId: { channel: 'telegram', externalId: `${PREFIX}-chat` } }, data: { isActive: true, phase: 0 } });
    const supplier = await prisma.supplier.create({ data: { category: 'man_and_van', name: `${PREFIX}-van`, serviceArea: ['LONDON'], languages: ['en'], pool: 'A', roughPrice: '£40/h' } });

    const jev = { evaluate: vi.fn(async ({ inputRef, phase }: { inputRef: string; phase: 0 | 1 | 2 }) => {
      await repos.traces.create({ kind: 'jev', inputRef, output: { stub: true }, phase, latencyMs: 1, costMicro: 17 });
      return { ok: true, usage: { input_tokens: 400 }, answers: {
        is_demand: { type: 'noul', noul: 0.92 }, is_supply: { type: 'noul', noul: 0.05 },
        category: { type: 'choice', choice: 'man_and_van', probabilities: { man_and_van: 0.9 }, confidence: 0.9 },
        urgency: { type: 'score', score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
        has_location: { type: 'noul', noul: 0.9 }, is_sensitive: { type: 'noul', noul: 0.01 }, is_move_event: { type: 'noul', noul: 0.1 },
      } };
    }) };
    const modelProvider = stubProvider([
      { tool: 'upsert_demand', args: { category: 'man_and_van', fromPostcode: 'E14', toPostcode: 'SE1', confidence: 0.9, lang: 'en' } },
      { tool: 'find_suppliers', args: {} },
      { tool: 'reply_in_group', args: { text: 'Here are options', supplierIds: [supplier.id] } },
      { text: 'done' },
    ]);
    const deps = {
      env: { DEFAULT_PHASE: 0, DEEPSEEK_MODEL: 'stub' }, repos, jev, thresholds: DEFAULT_THRESHOLDS, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      evaluateOutbound: vi.fn(), evaluateInbound: (await import('@matchbot/jev')).evaluateInbound,
      runInbound: (p: Parameters<typeof runInbound>[0]) => runInbound({ ...p, modelProvider }),
      publishApproval: vi.fn(), cards: { sendApprovalCard: vi.fn() },
    } as never;

    await processInbound(deps, { channel: 'telegram', chatId: `${PREFIX}-chat`, messageId: '1', userId: `${PREFIX}-user`, text: 'need a van Sunday E14 to SE1', receivedAt: new Date().toISOString() });

    const out = await prisma.outboundMessage.findMany({ where: { target: `${PREFIX}-chat` } });
    expect(out.map((o) => o.status)).toEqual(['dry_run']);
    expect(out[0]!.text).toContain('not part of the transaction');
    const msg = await prisma.message.findFirst({ where: { user: { externalId: `${PREFIX}-user` } } });
    const kinds = new Set((await prisma.decisionTrace.findMany({ where: { inputRef: msg!.id } })).map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['gate', 'jev']);           // rule 只在黑名单命中时写；agent_run 的 inputRef 是 traceId，另查
    expect(await prisma.decisionTrace.count({ where: { kind: 'agent_run' } })).toBeGreaterThan(0);
    expect(await prisma.outboundMessage.count({ where: { target: `${PREFIX}-chat`, status: 'pending' } })).toBe(0);
    await prisma.supplier.delete({ where: { id: supplier.id } });
  });
});

function stubProvider(calls: Array<{ tool: string; args: unknown } | { text: string }>) {
  let i = 0;
  return { getModel: async () => ({ getResponse: async () => { const c = calls[i++]!; return 'tool' in c ? toolCallResponse(c.tool, c.args) : textResponse(c.text); }, getStreamedResponse: async function* () {} }) };
}
```

`@matchbot/agent/tests/helpers/model-stub.js` 的导入路径需要在 `packages/agent/package.json` 的 `exports` 加 `"./tests/*"` 子路径，或把 helper 移到 `packages/agent/src/testing/model-stub.ts` 并从主入口导出（推荐后者，P8 Task 5 执行时一并做）。`stubProvider` 的 `Model` 接口形状以 PoC V1 观察为准。

- [~] **Step 3: 本地全链路冒烟**（部分：进程启动 + cron + 队列链路实测；真实群消息与 Phase 1 审批卡未做，见完成记录）

Run: `pnpm infra:up && pnpm dev:worker`（另一终端 `pnpm dev:bot`）
手动：在已开启的测试群发"need a van Sunday E14 to SE1"。
Expected（Phase 0）：`decision_traces` 出现 jev 与 gate 记录，`outbound_messages` 一行 `dry_run`，群里没有任何回复。
把该群 `phase` 改 1 再发一条：运营群收到审批卡；点批准；群里出现回复；`run_states.status = consumed`。

- [ ] **Step 4: 全量检查并提交**（并行约定：只跑了 `pnpm vitest run apps/worker` + worker typecheck + eslint/prettier；全量 `pnpm check` 与提交由协调者做）

Run: `pnpm check`

```bash
git add apps/worker packages/queue plan/interfaces.md
git commit -m "feat(worker): wire main process, cron and shadow e2e"
```

---

## 完成记录

| 项 | 内容 |
|---|---|
| 状态 | **完成（有 1 个需协调者决策的阻塞项，见下）** |
| 执行者 | 子 agent（P11），与 P12 并行，未跑任何 git 命令 |
| PR | 未提交；改动仅在 `apps/worker/` 与本文件 |
| 冒烟结果（Phase 0 / Phase 1） | **Phase 0：通过。** `pnpm vitest run apps/worker` → 4 files / 21 tests passed。其中 `tests/e2e/shadow.test.ts` 用真实 Postgres + 真实仓储 + 真实 gating/agent 编排（Jev 与模型是 stub），断言群消息 → `outbound_messages` 恰好一行 `dry_run`、文案含免责声明、`pending` 行数为 0、`decision_traces` 只有 `jev` + `gate` 两类且含 `entered_agent` / `agent_completed` / 出站门。进程级：`tsx src/main.ts` 启动后写 `worker started`，三个 cron job 被 scheduler 立即触发并各自执行（`redacted messages` / `expired demands` / `expired run states`，n=0），SIGTERM 能优雅退出。队列链路：经 `enqueueInbound` 投一条黑名单消息，worker 真实消费并写出 `{kind:'rule', output:{outcome:'dropped_by_rule', reason:'blacklist'}}`。**Phase 1：未做**——需要真实群、真实模型调用和人工点按钮，且审批卡发送当前被下面的阻塞项挡住。 |
| 接口补充（runStates.findById、approvals.findById、run_states.chatId/phase、createWorker jobName） | 四项**均已存在**，无需补：`repos.runStates.findById` / `repos.approvals.findById` 在 P2 已实现；`run_states` 已有 `chat_id`、`phase` 列且 P8 的 `settle()` 写入；`createWorker(name, redisUrl, handler(data, jobName), opts)` 第二个回调参数就是 `job.name`，cron 队列靠它分派。 |

### 与计划的偏差（AGENTS.md §9.1）

| # | 原计划 | 实际 | 为什么 |
|---|---|---|---|
| 1 | `processResume` 自己拼 `MatchContext` 并传给 `resumeRun({ deps, runState, approval, ctx })` | `resumeRun({ deps, runState, approval })`，**没有 `ctx` 参数**；`processResume` 不再拼上下文 | `packages/agent/src/run.ts` 的真实签名只有三个字段，内部用 `rebuildContext()` 从 `run_states.userId/chatId/phase` + `demands.findOpenByUser` 重建。与 `interfaces.md` 一致。计划里「用 `chatId: rs.chatId, phase: rs.phase` 替换空字符串」的提醒已由 agent 包自己落实 |
| 2 | `scheduleCron` 用 `q.cron.add(name, {}, { repeat: { every }, jobId })` | `q.cron.upsertJobScheduler(name, { every }, { name, data: {} })` | **BullMQ 6 移除了 `Queue.add` 的 `repeat` 选项**：`node_modules/bullmq/dist/esm/types/job-options.d.ts` 明写 “`repeat` is no longer a valid option for `Queue.add`; use `Queue.upsertJobScheduler`”。按计划写会静默变成一次性 job。scheduler id 与 job name 都取 cron 名，worker 的 `job.name` 分派不变 |
| 3 | `createTraceProcessor({ traces, phase: () => env.DEFAULT_PHASE })` | `createTraceProcessor({ traces, logger })` | P8 实际签名如此；phase 由 Runner 的 `traceMetadata` 注入（PoC V6 ②），不需要回调 |
| 4 | e2e 断言 `decisionTrace.count({ kind: 'agent_run' }) > 0` | **删掉该断言**，改断言 `jev` + `gate`（含出站门 `gate: 'outbound'`）与 `entered_agent` / `agent_completed` | PoC V6 ⑥ 的结论在本仓库实测坐实：`@openai/agents-core/dist/config.mjs:81` 在 `NODE_ENV === 'test'` 时 `tracing.disabled === true`，vitest 下 SDK 根本不产生 span，processor 收不到回调。实测跑完 e2e 后库里 `agent_run` 行数为 0。`agent_run` 的覆盖由 `packages/agent/tests/tracing.test.ts` 直接喂假 span 完成 |
| 5 | e2e 从 `@matchbot/agent/tests/helpers/model-stub.js` 导入 stub（计划说 P8 Task 5 会做） | 该文件**不存在**；改为在 `apps/worker/tests/e2e/model-stub.ts` 手写协议对象（`assistantMessage` / `functionCall` / `ModelResponse` 形状） | P8 没有落这个 helper，`packages/agent` 的测试直接用 `@openai/agents/testing` 的 `ScriptedModel`。但 AGENTS.md §3.2 只允许 `packages/agent` 直接 import `@openai/agents`，apps/worker 连测试里也不该碰，所以手写等价的纯数据对象。不改 `packages/agent`（并行约定：不碰别人的目录） |
| 6 | 代码门只有黑名单一条 | 代码门补齐架构 §3 的四项：空文本 / 斜杠命令 / 黑名单 / 群未接入或 `isActive=false`，且**放在落库之前** | 架构 §3 的「代码门」格子写的就是这四项；放在 `messages.create` 之前可以不留存被规则挡下的文本（AGENTS.md §6）。这类 trace 的 `inputRef` 因此不是 message id，用 `${channel}:${chatId}:${messageId}` |
| 7 | `processResume` 只写一条 trace 就结束 | 恢复后若**再次中断**，重新取 `run_states` 并再发一张审批卡 | PoC V2 ②：「批准一次 ≠ 跑完」，`settle()` 会新写一行 `pending`。不补这一步，第二次中断就永远没人批 |
| 8 | `buildDeps` 里 `new Bot(env.TELEGRAM_BOT_TOKEN)` 造 `createOpsCardSender` | **未实现**；`cards` 改为可注入端口，默认是 `createUnwiredCards()`——被调用时写 error 级日志而不是静默丢卡 | 见下面的阻塞项 |

### 阻塞项：worker 无法发送审批卡（需协调者决策）

计划的 `deps.ts` 要在 `apps/worker` 里 `new Bot(...)`，但 AGENTS.md §3.2 与 `scripts/check-deps.mjs` 的 `EXTERNAL_OWNERS` 都只允许 `packages/channel-telegram` 和 `@matchbot/bot` 直接依赖 `grammy`；`apps/worker/package.json` 里也没有这个依赖（现在能 `import` 只是因为 grammy 是根 devDependency 被提升，属于 phantom dependency）。并行约定禁止本 agent 改 `package.json`、`AGENTS.md`、`check-deps.mjs`，所以停在这里报告。

现状：`buildDeps({ cards })` 接受注入；不注入时用 `createUnwiredCards(logger)` 占位，Phase 0 不产生中断所以完全不受影响，Phase 1 一旦用到会打 error 日志（不会静默）。三个可选方案，任选其一后 `apps/worker/src/deps.ts` 只需改几行：

1. 把 `grammy` 加进 `apps/worker` 的 dependencies，并在 `check-deps.mjs` 的 `EXTERNAL_OWNERS.grammy` 加 `@matchbot/worker`（与 `apps/bot` 的先例一致，AGENTS.md §3.2 同步改一句）；
2. 在 `packages/channel-telegram` 加一个 `createOpsCardSenderFromToken({ token, opsChatId })`，让 Bot 在 channel 包里创建，worker 不碰 grammy（最贴合 §3.2 的原意）；
3. 让 `apps/bot` 来发卡（worker 经队列把卡交给 bot），需要新的队列与载荷 schema。

### 遗留

- Task 3 Step 3 的「真实群消息 + Phase 1 点批准」冒烟未做：需要真人在测试群发消息、真实 deepseek/Jev 调用，且被上面的阻塞项挡住。
- `MatchContext.recentReplies` 恒为 `[]`：`repos.outbound` 没有「按 target 列最近已发消息」的方法，补这个方法属于 `packages/db` 的改动，未擅自动。Phase 0/1 不影响（出站门只在 Phase 2 用 `recentReplies` 喂 Jev）。
- 同一用户串行目前靠 `concurrency: 1` 全局串行（计划 Global Constraints 允许的起步做法），Phase 2 再按 userId 分组。
