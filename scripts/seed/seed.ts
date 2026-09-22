/**
 * Phase 0 基础数据录入（P13 §B）。读 JSON → upsert `suppliers` / `groups`，可重复执行。
 *
 *   set -a && . ./.env && set +a
 *   pnpm exec tsx scripts/seed/seed.ts scripts/seed/data.json [--dry-run]
 *
 * 业务数据（Brief §3 的 30 家 B 池、§4 的 8 个群）由人填 `data.json`，本脚本只负责校验与写入。
 * 校验失败即整体中止，绝不写半截。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DEMAND_CATEGORIES } from '../../packages/domain/src/index.js';
import { disconnectPrisma, getPrisma } from '../../packages/db/src/index.js';

const supplierSchema = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  name: z.string().min(1),
  phone: z.string().nullish(),
  whatsapp: z.string().nullish(),
  telegram: z.string().nullish(),
  website: z.string().nullish(),
  // outward code（E14、SE1…）或 LONDON 全城
  serviceArea: z.array(z.string().min(2)).min(1),
  basePostcode: z.string().nullish(),
  priceType: z.enum(['hourly', 'fixed', 'quote']).nullish(),
  roughPrice: z.string().nullish(),
  isSameDay: z.boolean().default(false),
  isWeekend: z.boolean().default(false),
  languages: z.array(z.string()).default([]),
  source: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  pool: z.enum(['A', 'B']).default('B'),
  isWillingToReceiveLeads: z.boolean().default(false),
  // 核实日期。matcher 按 60 天判 stale 降权，留空等于永远算过期，所以录入时必须给。
  lastVerifiedAt: z.iso.date().nullish(),
});

const groupSchema = z.object({
  channel: z.literal('telegram').default('telegram'),
  externalId: z.string().min(1), // Telegram chat id，负数，字符串存（AGENTS.md §4.1）
  name: z.string().min(1),
  phase: z.number().int().min(0).max(2).default(0),
  categoriesEnabled: z.array(z.enum(DEMAND_CATEGORIES)).default([]),
  adminContact: z.string().nullish(),
  rateLimitPerDay: z.number().int().positive().default(3),
  isActive: z.boolean().default(false), // 默认关闭：管理员同意后才手动开（PRD §6.2）
});

const fileSchema = z.object({
  suppliers: z.array(supplierSchema).default([]),
  groups: z.array(groupSchema).default([]),
});

const path = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!path) throw new Error('usage: tsx scripts/seed/seed.ts <data.json> [--dry-run]');

const data = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

// A 池必须有可用联系方式，否则 lead 发不出去（P13 §B 第二项）
for (const s of data.suppliers) {
  if (s.pool === 'A' && !s.telegram && !s.whatsapp) {
    throw new Error(`A 池供应商 ${s.name} 缺 telegram/whatsapp 联系方式`);
  }
}

const aPool = data.suppliers.filter((s) => s.pool === 'A' && s.isWillingToReceiveLeads).length;
console.log(
  `解析成功：suppliers=${data.suppliers.length}（A 池且愿收 lead=${aPool}），groups=${data.groups.length}`,
);
if (dryRun) {
  console.log('--dry-run：未写库');
  process.exit(0);
}

const prisma = getPrisma(process.env.DATABASE_URL ?? '');
try {
  for (const s of data.suppliers) {
    // 同 category + name 视为同一家，重复执行不产生重复行
    const existing = await prisma.supplier.findFirst({
      where: { category: s.category, name: s.name },
    });
    const data = {
      ...s,
      lastVerifiedAt: s.lastVerifiedAt ? new Date(`${s.lastVerifiedAt}T00:00:00Z`) : null,
    };
    if (existing) await prisma.supplier.update({ where: { id: existing.id }, data });
    else await prisma.supplier.create({ data });
  }
  for (const g of data.groups) {
    await prisma.group.upsert({
      where: { channel_externalId: { channel: g.channel, externalId: g.externalId } },
      create: g,
      update: g,
    });
  }
  const [ns, ng] = await Promise.all([prisma.supplier.count(), prisma.group.count()]);
  console.log(`写入完成：suppliers 共 ${ns} 行，groups 共 ${ng} 行`);
} finally {
  await disconnectPrisma();
}
