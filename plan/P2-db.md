# P2 db：迁移与仓储层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成首个迁移，实现 `createRepositories(prisma)`，用真实 Postgres 跑集成测试，让上层包只通过仓储访问数据库。

**Architecture:** 一个仓储文件对应一张表（或一组强相关表），全部挂在 `createRepositories` 返回的对象上。集成测试用 docker 里的 Postgres，每个用例在事务里跑并回滚，用 `prisma.$transaction` 包住测试体。

**Tech Stack:** Prisma 7.10（`prisma-client` 生成器 + `@prisma/adapter-pg`）、Postgres 17、vitest 5

**Spec:** `plan/interfaces.md` §db；`docs/技术架构设计.md` §6；`packages/db/prisma/schema.prisma`（已存在）

## Global Constraints

- 只有 `packages/db` 能 import `@prisma/client` / `pg`（AGENTS.md §3.2）。
- 命名遵守 AGENTS.md §4.1；schema 已按此写好，不要改列名。
- `runStates.consume` 必须是原子条件更新（AGENTS.md §3.3 第 6 条）。
- `demands.setStatus` 必须用 `@matchbot/domain` 的 `transition` 校验。
- 集成测试文件放 `packages/db/tests/integration/`，用 `DATABASE_URL` 指向 docker 库；`pnpm test` 默认会跑它们，所以 CI 与本地都要先 `pnpm infra:up`。

---

### Task 1: 首个迁移与测试基座

**Files:**
- Create: `packages/db/prisma/migrations/<timestamp>_init/migration.sql`（由 prisma 生成）
- Create: `packages/db/tests/integration/setup.ts`
- Modify: `packages/db/package.json`（scripts 已有 `migrate`）

**Interfaces:**
- Produces: `withTestDb(fn: (prisma: PrismaClient) => Promise<void>)`，在事务中执行并回滚

- [ ] **Step 1: 起库并生成迁移**

Run: `pnpm infra:up && cp -n .env.example .env; cd packages/db && DATABASE_URL=postgresql://matchbot:matchbot@localhost:5432/matchbot pnpm exec prisma migrate dev --name init`
Expected: `prisma/migrations/<ts>_init/migration.sql` 生成，包含 13 张表与 8 个 enum。

- [ ] **Step 2: 测试基座**

```ts
// packages/db/tests/integration/setup.ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/client.js';

const url = process.env.DATABASE_URL ?? 'postgresql://matchbot:matchbot@localhost:5432/matchbot';
export const testPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

/** 每个用例在事务里执行，最后抛出哨兵错误回滚，保证用例互不污染。 */
class Rollback extends Error {}
export async function withTestDb(fn: (tx: PrismaClient) => Promise<void>): Promise<void> {
  try {
    await testPrisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaClient);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
```

- [ ] **Step 3: 冒烟测试**

```ts
// packages/db/tests/integration/smoke.test.ts
import { describe, expect, it } from 'vitest';
import { withTestDb } from './setup.js';

describe('db smoke', () => {
  it('can insert and read a user inside a rolled-back tx', async () => {
    await withTestDb(async (tx) => {
      const u = await tx.user.create({ data: { channel: 'telegram', externalId: '1', languages: ['en'], lastSeenAt: new Date() } });
      expect((await tx.user.findUnique({ where: { id: u.id } }))?.externalId).toBe('1');
    });
  });
});
```

Run: `pnpm vitest run packages/db/tests/integration/smoke.test.ts`
Expected: 1 passed；再跑一次仍通过（证明回滚生效，无唯一键冲突）。

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/migrations packages/db/tests
git commit -m "feat(db): initial migration and integration test harness"
```

---

### Task 2: users / groups / messages 仓储

**Files:**
- Create: `packages/db/src/repos/users.ts`、`groups.ts`、`messages.ts`
- Create: `packages/db/src/repos/index.ts`（`createRepositories`）
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/integration/users-groups-messages.test.ts`

**Interfaces:**
- Produces: `createRepositories(prisma): Repositories`（本任务先挂 users/groups/messages，后续任务逐个补齐）

- [ ] **Step 1: 写失败测试**

```ts
// packages/db/tests/integration/users-groups-messages.test.ts
import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('users/groups/messages', () => {
  it('upsertByExternal is idempotent and records lang', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.users.upsertByExternal({ channel: 'telegram', externalId: '42', lang: 'ru' });
      const b = await r.users.upsertByExternal({ channel: 'telegram', externalId: '42' });
      expect(a.id).toBe(b.id);
      expect(b.languages).toContain('ru');
    });
  });
  it('messages.recentByUser returns newest first within window', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: '7' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-100', name: 'test' });
      await r.messages.create({ groupId: g.id, userId: u.id, externalId: '1', text: 'old', receivedAt: new Date(Date.now() - 48 * 3600e3) });
      await r.messages.create({ groupId: g.id, userId: u.id, externalId: '2', text: 'new', receivedAt: new Date() });
      const recent = await r.messages.recentByUser(u.id, 24);
      expect(recent.map((m) => m.text)).toEqual(['new']);
    });
  });
  it('redactOlderThan blanks text but keeps hash', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: '8' });
      await r.messages.create({ groupId: null, userId: u.id, externalId: '9', text: 'secret', receivedAt: new Date(Date.now() - 40 * 86400e3) });
      expect(await r.messages.redactOlderThan(30)).toBe(1);
      const m = (await r.messages.recentByUser(u.id, 24 * 60))[0]!;
      expect(m.text).toBe('');
      expect(m.textHash).toHaveLength(64);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/db/tests/integration/users-groups-messages.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// packages/db/src/repos/users.ts
import type { Channel, PrismaClient, User } from '../generated/client.js';

export function usersRepo(prisma: PrismaClient) {
  return {
    async upsertByExternal(p: { channel: Channel; externalId: string; lang?: string }): Promise<User> {
      const existing = await prisma.user.findUnique({ where: { channel_externalId: { channel: p.channel, externalId: p.externalId } } });
      const languages = new Set(existing?.languages ?? []);
      if (p.lang) languages.add(p.lang);
      if (existing) {
        return prisma.user.update({ where: { id: existing.id }, data: { languages: [...languages], lastSeenAt: new Date() } });
      }
      return prisma.user.create({ data: { channel: p.channel, externalId: p.externalId, languages: [...languages], lastSeenAt: new Date() } });
    },
    findById(id: string): Promise<User | null> {
      return prisma.user.findUnique({ where: { id } });
    },
  };
}
```

```ts
// packages/db/src/repos/groups.ts
import type { Channel, Group, PrismaClient } from '../generated/client.js';

export function groupsRepo(prisma: PrismaClient) {
  return {
    findByExternal(channel: Channel, externalId: string): Promise<Group | null> {
      return prisma.group.findUnique({ where: { channel_externalId: { channel, externalId } } });
    },
    upsert(p: { channel: Channel; externalId: string; name: string }): Promise<Group> {
      return prisma.group.upsert({
        where: { channel_externalId: { channel: p.channel, externalId: p.externalId } },
        create: { channel: p.channel, externalId: p.externalId, name: p.name, categoriesEnabled: [] },
        update: { name: p.name },
      });
    },
  };
}
```

```ts
// packages/db/src/repos/messages.ts
import { hashText } from '@matchbot/shared';
import type { Message, PrismaClient } from '../generated/client.js';

export function messagesRepo(prisma: PrismaClient) {
  return {
    create(p: { groupId: string | null; userId: string; externalId: string; text: string; lang?: string; receivedAt: Date }): Promise<Message> {
      return prisma.message.create({
        data: { groupId: p.groupId, userId: p.userId, externalId: p.externalId, text: p.text, textHash: hashText(p.text), lang: p.lang ?? null, receivedAt: p.receivedAt },
      });
    },
    recentByUser(userId: string, sinceHours: number): Promise<Message[]> {
      return prisma.message.findMany({
        where: { userId, receivedAt: { gte: new Date(Date.now() - sinceHours * 3600e3) } },
        orderBy: { receivedAt: 'desc' },
        take: 50,
      });
    },
    async redactOlderThan(days: number): Promise<number> {
      const r = await prisma.message.updateMany({
        where: { receivedAt: { lt: new Date(Date.now() - days * 86400e3) }, NOT: { text: '' } },
        data: { text: '' },
      });
      return r.count;
    },
  };
}
```

```ts
// packages/db/src/repos/index.ts
import type { PrismaClient } from '../generated/client.js';
import { groupsRepo } from './groups.js';
import { messagesRepo } from './messages.js';
import { usersRepo } from './users.js';

export function createRepositories(prisma: PrismaClient) {
  return {
    users: usersRepo(prisma),
    groups: groupsRepo(prisma),
    messages: messagesRepo(prisma),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
```

`packages/db/src/index.ts` 追加 `export { createRepositories, type Repositories } from './repos/index.js';`

注意 `Message.groupId` 为 `null` 时 `@@unique([groupId, externalId])` 在 Postgres 里不约束私聊消息重复，这是预期（私聊去重靠队列 jobId）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/db/tests/integration/users-groups-messages.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): users, groups, messages repositories"
```

---

### Task 3: demands / supplies / suppliers / matches / leads 仓储

**Files:**
- Create: `packages/db/src/repos/demands.ts`、`supplies.ts`、`suppliers.ts`、`matches.ts`、`leads.ts`
- Modify: `packages/db/src/repos/index.ts`
- Test: `packages/db/tests/integration/marketplace.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/db/tests/integration/marketplace.test.ts
import { IllegalTransitionError } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('demands', () => {
  it('create + findOpenByUser + setStatus honours the state machine', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd1' });
      const d = await r.demands.create({ userId: u.id, category: 'man_and_van', confidence: 0.9, sourceMessageId: 'm1', fromPostcode: 'E14' });
      expect((await r.demands.findOpenByUser(u.id)).map((x) => x.id)).toEqual([d.id]);
      await r.demands.setStatus(d.id, 'closed');
      await expect(r.demands.setStatus(d.id, 'open')).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(await r.demands.findOpenByUser(u.id)).toEqual([]);
    });
  });
  it('update appends sourceMessageId', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd2' });
      const d = await r.demands.create({ userId: u.id, category: 'man_and_van', confidence: 0.5, sourceMessageId: 'm1' });
      const d2 = await r.demands.update(d.id, { toPostcode: 'SE1', sourceMessageId: 'm2' });
      expect(d2.toPostcode).toBe('SE1');
      expect(d2.sourceMessageIds).toEqual(['m1', 'm2']);
    });
  });
});

describe('suppliers + matches + leads', () => {
  it('replaceForDemand replaces rows and leads attach to a match', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd3' });
      const d = await r.demands.create({ userId: u.id, category: 'man_and_van', confidence: 0.9, sourceMessageId: 'm1' });
      const s = await tx.supplier.create({ data: { category: 'man_and_van', name: 'Van Co', serviceArea: ['E14'], languages: ['en'], pool: 'A' } });
      expect((await r.suppliers.findCandidates({ category: 'man_and_van', pool: 'A' })).map((x) => x.id)).toContain(s.id);
      await r.matches.replaceForDemand(d.id, [{ supplierId: s.id, matcherScore: 0.8, rank: 1 }]);
      const [m] = await r.matches.replaceForDemand(d.id, [{ supplierId: s.id, matcherScore: 0.9, rank: 1 }]);
      expect(await tx.match.count({ where: { demandId: d.id } })).toBe(1);
      const lead = await r.leads.create({ matchId: m!.id, sentVia: 'telegram', sentAt: new Date() });
      expect((await r.leads.update(lead.id, { supplierResponse: 'quote' })).supplierResponse).toBe('quote');
    });
  });
});

describe('supplies', () => {
  it('findActive excludes expired', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd4' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-1', name: 'g' });
      await r.supplies.create({ userId: u.id, groupId: g.id, category: 'man_and_van', expiresAt: new Date(Date.now() - 1000).toISOString(), sourceMessageId: 'm1' });
      await r.supplies.create({ userId: u.id, groupId: g.id, category: 'man_and_van', expiresAt: new Date(Date.now() + 86400e3).toISOString(), sourceMessageId: 'm2' });
      expect(await r.supplies.findActive('man_and_van')).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/db/tests/integration/marketplace.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/db/src/repos/demands.ts
import { transition, type DemandDraft, type DemandStatus } from '@matchbot/domain';
import type { Demand, PrismaClient } from '../generated/client.js';

function draftToData(d: Partial<DemandDraft>) {
  return {
    whenText: d.whenText,
    whenAt: d.whenAt ? new Date(d.whenAt) : undefined,
    fromPostcode: d.fromPostcode,
    toPostcode: d.toPostcode,
    quantity: d.quantity,
    budgetPence: d.budgetPence,
    lang: d.lang,
    confidence: d.confidence,
  };
}

export function demandsRepo(prisma: PrismaClient) {
  return {
    findOpenByUser(userId: string): Promise<Demand[]> {
      return prisma.demand.findMany({ where: { userId, status: { in: ['open', 'clarifying', 'matched'] } }, orderBy: { updatedAt: 'desc' } });
    },
    create(p: DemandDraft & { userId: string; sourceMessageId: string; isMoveEvent?: boolean }): Promise<Demand> {
      return prisma.demand.create({
        data: { ...draftToData(p), userId: p.userId, category: p.category, confidence: p.confidence, isMoveEvent: p.isMoveEvent ?? false, sourceMessageIds: [p.sourceMessageId] },
      });
    },
    async update(id: string, patch: Partial<DemandDraft> & { sourceMessageId?: string }): Promise<Demand> {
      const current = await prisma.demand.findUniqueOrThrow({ where: { id } });
      const ids = patch.sourceMessageId && !current.sourceMessageIds.includes(patch.sourceMessageId) ? [...current.sourceMessageIds, patch.sourceMessageId] : current.sourceMessageIds;
      return prisma.demand.update({ where: { id }, data: { ...draftToData(patch), category: patch.category, sourceMessageIds: ids } });
    },
    async setStatus(id: string, status: DemandStatus): Promise<Demand> {
      const current = await prisma.demand.findUniqueOrThrow({ where: { id } });
      transition(current.status, status); // 非法转移抛 IllegalTransitionError
      return prisma.demand.update({ where: { id }, data: { status } });
    },
    async expireOlderThan(days: number): Promise<number> {
      const r = await prisma.demand.updateMany({
        where: { status: { in: ['open', 'clarifying'] }, updatedAt: { lt: new Date(Date.now() - days * 86400e3) } },
        data: { status: 'expired' },
      });
      return r.count;
    },
  };
}
```

```ts
// packages/db/src/repos/supplies.ts
import type { DemandCategory, SupplyDraft } from '@matchbot/domain';
import type { PrismaClient, Supply } from '../generated/client.js';

export function suppliesRepo(prisma: PrismaClient) {
  return {
    create(p: SupplyDraft & { userId: string; groupId: string; sourceMessageId: string }): Promise<Supply> {
      return prisma.supply.create({ data: { userId: p.userId, groupId: p.groupId, category: p.category, availability: p.availability, area: p.area, expiresAt: new Date(p.expiresAt), sourceMessageId: p.sourceMessageId } });
    },
    findActive(category: DemandCategory): Promise<Supply[]> {
      return prisma.supply.findMany({ where: { category, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    },
  };
}
```

```ts
// packages/db/src/repos/suppliers.ts
import type { DemandCategory } from '@matchbot/domain';
import type { PrismaClient, Supplier } from '../generated/client.js';

export function suppliersRepo(prisma: PrismaClient) {
  return {
    findCandidates(p: { category: DemandCategory; pool?: 'A' | 'B' }): Promise<Supplier[]> {
      return prisma.supplier.findMany({ where: { category: p.category, ...(p.pool ? { pool: p.pool } : {}) }, orderBy: [{ pool: 'asc' }, { rating: 'desc' }] });
    },
    findByIds(ids: string[]): Promise<Supplier[]> {
      return prisma.supplier.findMany({ where: { id: { in: ids } } });
    },
  };
}
```

```ts
// packages/db/src/repos/matches.ts
import type { Match, PrismaClient } from '../generated/client.js';

export function matchesRepo(prisma: PrismaClient) {
  return {
    async replaceForDemand(demandId: string, rows: Array<{ supplierId?: string; supplyId?: string; matcherScore: number; jevFit?: number; rank: number }>): Promise<Match[]> {
      await prisma.match.deleteMany({ where: { demandId } });
      const out: Match[] = [];
      for (const r of rows) out.push(await prisma.match.create({ data: { demandId, supplierId: r.supplierId, supplyId: r.supplyId, matcherScore: r.matcherScore, jevFit: r.jevFit, rank: r.rank } }));
      return out;
    },
  };
}
```

```ts
// packages/db/src/repos/leads.ts
import type { Channel, Lead, PrismaClient } from '../generated/client.js';

export function leadsRepo(prisma: PrismaClient) {
  return {
    create(p: { matchId: string; sentVia: Channel; sentAt: Date }): Promise<Lead> {
      return prisma.lead.create({ data: p });
    },
    update(id: string, patch: { supplierResponse?: string; isConverted?: boolean; isPaid?: boolean; followedUpAt?: Date }): Promise<Lead> {
      return prisma.lead.update({ where: { id }, data: patch });
    },
  };
}
```

`repos/index.ts` 加 `demands: demandsRepo(prisma), supplies: suppliesRepo(prisma), suppliers: suppliersRepo(prisma), matches: matchesRepo(prisma), leads: leadsRepo(prisma)`。

`exactOptionalPropertyTypes` 下 `undefined` 传给 Prisma 可选字段是允许的（Prisma 输入类型含 `| undefined`）；若类型报错，在 `draftToData` 里用 `?? null` 显式转换。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/db/tests/integration/marketplace.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): demands, supplies, suppliers, matches, leads repositories"
```

---

### Task 4: sessionItems / runStates / approvals / outbound / traces 仓储

**Files:**
- Create: `packages/db/src/repos/session-items.ts`、`run-states.ts`、`approvals.ts`、`outbound.ts`、`traces.ts`
- Modify: `packages/db/src/repos/index.ts`
- Test: `packages/db/tests/integration/runtime.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/db/tests/integration/runtime.test.ts
import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('sessionItems', () => {
  it('append is idempotent per operationId and keeps order', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 's1' });
      await r.sessionItems.append(u.id, [{ role: 'user', content: 'a' }], 'op1');
      await r.sessionItems.append(u.id, [{ role: 'user', content: 'a' }], 'op1');
      await r.sessionItems.append(u.id, [{ role: 'assistant', content: 'b' }]);
      expect((await r.sessionItems.list(u.id)).length).toBe(2);
      expect(await r.sessionItems.popLast(u.id)).toEqual({ role: 'assistant', content: 'b' });
      await r.sessionItems.clear(u.id);
      expect(await r.sessionItems.list(u.id)).toEqual([]);
    });
  });
});

describe('runStates.consume', () => {
  it('returns the row once, null the second time', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'r1' });
      const rs = await r.runStates.create({ userId: u.id, snapshot: '{}', agentVersion: '0.0.0', sdkVersion: '0.18.0', interruptions: [], expiresAt: new Date(Date.now() + 1000) });
      expect((await r.runStates.consume(rs.id))?.id).toBe(rs.id);
      expect(await r.runStates.consume(rs.id)).toBeNull();
    });
  });
  it('expireOld marks pending rows past expiresAt', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'r2' });
      await r.runStates.create({ userId: u.id, snapshot: '{}', agentVersion: '0', sdkVersion: '0', interruptions: [], expiresAt: new Date(Date.now() - 1) });
      expect(await r.runStates.expireOld(new Date())).toBe(1);
    });
  });
});

describe('outbound', () => {
  it('claimPending returns pending only; countSentToTargetSince counts sent', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.outbound.create({ channel: 'telegram', target: '-1', text: 'x' }, 'pending');
      await r.outbound.create({ channel: 'telegram', target: '-1', text: 'y' }, 'dry_run');
      expect((await r.outbound.claimPending(10)).map((m) => m.id)).toEqual([a.id]);
      await r.outbound.markSent(a.id);
      expect(await r.outbound.countSentToTargetSince('-1', new Date(Date.now() - 60e3))).toBe(1);
      expect(await r.outbound.claimPending(10)).toEqual([]);
    });
  });
});

describe('traces', () => {
  it('create applies defaults and listByKind filters', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      await r.traces.create({ kind: 'jev', inputRef: 'm1', output: { ok: true }, phase: 0, latencyMs: 5, costMicro: 0 });
      await r.traces.create({ kind: 'rule', inputRef: 'm1', output: {}, phase: 0, latencyMs: 0, costMicro: 0 });
      expect(await r.traces.listByKind('jev', new Date(Date.now() - 60e3))).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/db/tests/integration/runtime.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/db/src/repos/session-items.ts
import type { PrismaClient } from '../generated/client.js';

export function sessionItemsRepo(prisma: PrismaClient) {
  return {
    async list(userId: string, limit?: number): Promise<unknown[]> {
      const rows = await prisma.sessionItem.findMany({ where: { userId }, orderBy: { seq: 'asc' } });
      const items = rows.map((r) => r.item as unknown);
      return limit ? items.slice(-limit) : items;
    },
    async append(userId: string, items: unknown[], operationId?: string): Promise<void> {
      if (operationId && (await prisma.sessionItem.count({ where: { userId, operationId } })) > 0) return;
      const max = await prisma.sessionItem.aggregate({ where: { userId }, _max: { seq: true } });
      let seq = max._max.seq ?? 0;
      await prisma.sessionItem.createMany({ data: items.map((item) => ({ userId, seq: ++seq, item: item as object, operationId: operationId ?? null })) });
    },
    async popLast(userId: string): Promise<unknown | null> {
      const last = await prisma.sessionItem.findFirst({ where: { userId }, orderBy: { seq: 'desc' } });
      if (!last) return null;
      await prisma.sessionItem.delete({ where: { id: last.id } });
      return last.item as unknown;
    },
    async clear(userId: string): Promise<void> {
      await prisma.sessionItem.deleteMany({ where: { userId } });
    },
  };
}
```

```ts
// packages/db/src/repos/run-states.ts
import type { PrismaClient, RunState } from '../generated/client.js';

export function runStatesRepo(prisma: PrismaClient) {
  return {
    create(p: { userId: string; snapshot: string; agentVersion: string; sdkVersion: string; interruptions: unknown; expiresAt: Date }): Promise<RunState> {
      return prisma.runState.create({ data: { ...p, interruptions: p.interruptions as object } });
    },
    /** 原子消费：条件更新 0 行即已被别人恢复过（AGENTS.md §3.3 第 6 条）。 */
    async consume(id: string): Promise<RunState | null> {
      const r = await prisma.runState.updateMany({ where: { id, status: 'pending' }, data: { status: 'consumed', consumedAt: new Date() } });
      if (r.count === 0) return null;
      return prisma.runState.findUnique({ where: { id } });
    },
    async expireOld(now: Date): Promise<number> {
      const r = await prisma.runState.updateMany({ where: { status: 'pending', expiresAt: { lt: now } }, data: { status: 'expired' } });
      return r.count;
    },
    findById(id: string): Promise<RunState | null> {
      return prisma.runState.findUnique({ where: { id } });
    },
  };
}
```

`create` 的入参按 interfaces.md 含 `chatId` 与 `phase`：在 Task 1 生成迁移**之前**给 `schema.prisma` 的 `RunState` 加两列 `chatId String @map("chat_id")`、`phase Int`，测试里的 `create` 调用相应加 `chatId: '-1', phase: 1`。

```ts
// packages/db/src/repos/approvals.ts
import type { Approval, PrismaClient } from '../generated/client.js';

export function approvalsRepo(prisma: PrismaClient) {
  return {
    create(p: { runStateId: string; reviewer: string; decision: 'approve' | 'reject' | 'edit' | 'ignore'; editedText?: string }): Promise<Approval> {
      return prisma.approval.create({ data: p });
    },
    findById(id: string): Promise<Approval | null> {
      return prisma.approval.findUnique({ where: { id } });
    },
  };
}
```

```ts
// packages/db/src/repos/outbound.ts
import type { OutboundDraft } from '@matchbot/domain';
import type { OutboundMessage, OutboundStatus, PrismaClient } from '../generated/client.js';

export function outboundRepo(prisma: PrismaClient) {
  return {
    create(draft: OutboundDraft, status: OutboundStatus): Promise<OutboundMessage> {
      return prisma.outboundMessage.create({ data: { channel: draft.channel, target: draft.target, text: draft.text, toolCallId: draft.toolCallId, status } });
    },
    claimPending(limit: number): Promise<OutboundMessage[]> {
      return prisma.outboundMessage.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: limit });
    },
    async markSent(id: string): Promise<void> {
      await prisma.outboundMessage.update({ where: { id }, data: { status: 'sent', sentAt: new Date() } });
    },
    async markFailed(id: string, error: string): Promise<void> {
      await prisma.outboundMessage.update({ where: { id }, data: { status: 'failed', error } });
    },
    countSentToTargetSince(target: string, since: Date): Promise<number> {
      return prisma.outboundMessage.count({ where: { target, status: 'sent', sentAt: { gte: since } } });
    },
  };
}
```

```ts
// packages/db/src/repos/traces.ts
import { decisionTraceInputSchema, type DecisionTraceInput, type TraceKind } from '@matchbot/domain';
import type { DecisionTrace, PrismaClient } from '../generated/client.js';

export function tracesRepo(prisma: PrismaClient) {
  return {
    create(input: DecisionTraceInput): Promise<DecisionTrace> {
      const t = decisionTraceInputSchema.parse(input);
      return prisma.decisionTrace.create({ data: { kind: t.kind, inputRef: t.inputRef, output: t.output as object, phase: t.phase, latencyMs: t.latencyMs, costMicro: t.costMicro } });
    },
    listByKind(kind: TraceKind, since: Date, limit = 1000): Promise<DecisionTrace[]> {
      return prisma.decisionTrace.findMany({ where: { kind, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: limit });
    },
  };
}
```

`repos/index.ts` 补齐五个仓储；此时 `Repositories` 与 interfaces.md §db 完全对应。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/db/tests/integration/runtime.test.ts`
Expected: 5 passed

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add packages/db
git commit -m "feat(db): session items, run states, approvals, outbound, traces repositories"
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
