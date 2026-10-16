import { transition, type DemandDraft, type DemandStatus } from '@matchbot/domain';
import type { Demand, Prisma, PrismaClient } from '../generated/client.js';

// Prisma 7 的输入类型在 exactOptionalPropertyTypes 下不收 undefined：
// create 用 ?? null 显式置空，update 只写补丁里出现的键（undefined 表示不动该字段）。
function draftToCreateData(d: DemandDraft) {
  return {
    need: d.need ?? null,
    whenText: d.whenText ?? null,
    whenAt: d.whenAt ? new Date(d.whenAt) : null,
    fromPostcode: d.fromPostcode ?? null,
    toPostcode: d.toPostcode ?? null,
    quantity: d.quantity ?? null,
    budgetPence: d.budgetPence ?? null,
    lang: d.lang ?? null,
    confidence: d.confidence,
  };
}

function draftToUpdateData(d: Partial<DemandDraft>): Prisma.DemandUpdateInput {
  const data: Prisma.DemandUpdateInput = {};
  if (d.need !== undefined) data.need = d.need;
  if (d.whenText !== undefined) data.whenText = d.whenText;
  if (d.whenAt !== undefined) data.whenAt = new Date(d.whenAt);
  if (d.fromPostcode !== undefined) data.fromPostcode = d.fromPostcode;
  if (d.toPostcode !== undefined) data.toPostcode = d.toPostcode;
  if (d.quantity !== undefined) data.quantity = d.quantity;
  if (d.budgetPence !== undefined) data.budgetPence = d.budgetPence;
  if (d.lang !== undefined) data.lang = d.lang;
  if (d.confidence !== undefined) data.confidence = d.confidence;
  if (d.category !== undefined) data.category = d.category;
  return data;
}

export function demandsRepo(prisma: PrismaClient) {
  return {
    findOpenByUser(userId: string): Promise<Demand[]> {
      return prisma.demand.findMany({
        where: { userId, status: { in: ['open', 'clarifying', 'matched'] } },
        orderBy: { updatedAt: 'desc' },
      });
    },
    async create(
      p: DemandDraft & { userId: string; sourceMessageId: string; isMoveEvent?: boolean },
    ): Promise<Demand> {
      const existing = await prisma.demand.findFirst({
        where: {
          userId: p.userId,
          category: p.category,
          sourceMessageIds: { has: p.sourceMessageId },
        },
      });
      if (existing) return existing;
      return prisma.demand.create({
        data: {
          ...draftToCreateData(p),
          userId: p.userId,
          category: p.category,
          isMoveEvent: p.isMoveEvent ?? false,
          sourceMessageIds: [p.sourceMessageId],
        },
      });
    },
    async update(
      id: string,
      patch: Partial<DemandDraft> & { sourceMessageId?: string },
    ): Promise<Demand> {
      const current = await prisma.demand.findUniqueOrThrow({ where: { id } });
      const ids =
        patch.sourceMessageId && !current.sourceMessageIds.includes(patch.sourceMessageId)
          ? [...current.sourceMessageIds, patch.sourceMessageId]
          : current.sourceMessageIds;
      return prisma.demand.update({
        where: { id },
        data: { ...draftToUpdateData(patch), sourceMessageIds: ids },
      });
    },
    async setStatus(id: string, status: DemandStatus): Promise<Demand> {
      const current = await prisma.demand.findUniqueOrThrow({ where: { id } });
      transition(current.status, status); // 非法转移抛 IllegalTransitionError
      return prisma.demand.update({ where: { id }, data: { status } });
    },
    async expireOlderThan(days: number): Promise<number> {
      const r = await prisma.demand.updateMany({
        where: {
          status: { in: ['open', 'clarifying'] },
          updatedAt: { lt: new Date(Date.now() - days * 86400e3) },
        },
        data: { status: 'expired' },
      });
      return r.count;
    },
  };
}
