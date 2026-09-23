/**
 * 把人工核实表（verified.json）合并进 seed 数据，优先级最高。
 *
 *   pnpm exec tsx scripts/seed/apply-verification.ts scripts/seed/data.json scripts/seed/verified.json
 *
 * 自动流水线（extract-brief → enrich-suppliers）只处理能精确比对的字段；服务范围、
 * 营业时间、评价这类要读懂上下文的判断放在核实表里，每条都附证据，便于抽查。
 * 核实表与 data.json 一样含真实商家联系方式，已 gitignore。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const outward = z.string().regex(/^(LONDON|[A-Z]{1,2}\d{1,2}[A-Z]?)$/);

// 只允许改这些列；拼错字段名直接报错，而不是悄悄写进一个不存在的列
const settable = z
  .object({
    phone: z.string().regex(/^0\d{10}$/),
    whatsapp: z
      .string()
      .regex(/^0\d{10}$/)
      .nullable(),
    email: z.string().email().nullable(),
    website: z.string().url().nullable(),
    sourceUrl: z.string().url().nullable(),
    serviceArea: z.array(outward).min(1),
    basePostcode: outward.nullable(),
    isSameDay: z.boolean(),
    isWeekend: z.boolean(),
    rating: z.number().min(1).max(5).nullable(),
    reviewCount: z.number().int().positive().nullable(),
  })
  .partial()
  .strict();

const entry = z
  .object({
    name: z.string().min(1),
    set: settable,
    phoneVerified: z.boolean(),
    needsHumanCheck: z.string().optional(),
    clearHumanCheck: z.boolean().optional(),
    evidence: z.record(z.string(), z.string()),
  })
  .refine((e) => !(e.needsHumanCheck && e.clearHumanCheck), '不能同时标记与清除人工复核');

const fileSchema = z.object({
  verifiedAt: z.iso.date(),
  rules: z.array(z.string()),
  suppliers: z.array(entry),
});

const [dataPath, verifiedPath] = process.argv.slice(2);
if (!dataPath || !verifiedPath) {
  throw new Error('usage: tsx scripts/seed/apply-verification.ts <data.json> <verified.json>');
}
const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
  suppliers: Record<string, unknown>[];
};
const verified = fileSchema.parse(JSON.parse(readFileSync(verifiedPath, 'utf8')));

const byName = new Map(data.suppliers.map((s) => [s.name as string, s]));
const unknown = verified.suppliers.filter((v) => !byName.has(v.name)).map((v) => v.name);
if (unknown.length) throw new Error(`核实表里有 data.json 不存在的供应商: ${unknown.join(', ')}`);

const lines: string[] = [];
for (const v of verified.suppliers) {
  const s = byName.get(v.name)!;
  const changed = Object.entries(v.set).filter(
    ([k, val]) => JSON.stringify(s[k] ?? null) !== JSON.stringify(val),
  );
  Object.assign(s, v.set);
  s.phoneVerified = v.phoneVerified;
  if (v.needsHumanCheck) s.needsHumanCheck = v.needsHumanCheck;
  if (v.clearHumanCheck) delete s.needsHumanCheck;
  // 只有这次真的核实到了，才刷新核实日期；没核实上的保留原日期，让 matcher 的 stale 降权照常生效
  if (v.phoneVerified) s.lastVerifiedAt = verified.verifiedAt;
  lines.push(`${v.name}: ${changed.map(([k]) => k).join(', ') || '无字段变化'}`);
}

const missing = data.suppliers.filter((s) => !verified.suppliers.some((v) => v.name === s.name));
writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
process.stderr.write(
  lines.join('\n') +
    `\n\n核实表覆盖 ${verified.suppliers.length}/${data.suppliers.length}` +
    (missing.length ? `；未覆盖: ${missing.map((s) => s.name).join(', ')}` : '') +
    '\n',
);
