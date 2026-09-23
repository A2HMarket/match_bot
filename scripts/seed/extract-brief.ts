/**
 * 从 Brief（docx）§3 Supply Seed 表抽出 30 家供应商，生成 seed.ts 能吃的 JSON。
 *
 *   pnpm exec tsx scripts/seed/extract-brief.ts > scripts/seed/data.json
 *
 * 这批数据是人工整理好的（含价格、营业时间、A/B 候选评级），不需要抓取。
 * 抓取只在需要把 B 池从 30 扩到 Brief 目标的 50–80 家、或刷新过期信息时才有意义。
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { DEMAND_CATEGORIES } from '../../packages/domain/src/index.js';

type Cell = { text: string; url: string | null };
type Row = Cell[];

// docx 是 zip，用 Node 自带 zlib 解 deflate，不引入依赖
function readDocxXml(path: string, entry: string): string {
  const buf = readFileSync(path);
  let p = 0;
  while (p < buf.length - 4) {
    if (buf.readUInt32LE(p) !== 0x04034b50) {
      p++;
      continue;
    }
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    if (name === entry && compSize > 0) {
      const data = buf.subarray(dataStart, dataStart + compSize);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p = dataStart + compSize;
  }
  throw new Error(`entry not found: ${entry}`);
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 解析所有表格：标签可能带属性，所以按 `<w:tbl` / `<w:tr` / `<w:tc` 前缀切 */
function allTables(xml: string, rels: Map<string, string>): Row[][] {
  return xml
    .split(/<w:tbl[\s>]/)
    .slice(1)
    .map((tbl) =>
      (tbl.split(/<\/w:tbl>/)[0] ?? '')
        .split(/<w:tr[\s>]/)
        .slice(1)
        .map((tr) =>
          (tr.split(/<\/w:tr>/)[0] ?? '')
            .split(/<w:tc[\s>]/)
            .slice(1)
            .map((tc) => {
              const body = tc.split(/<\/w:tc>/)[0] ?? '';
              const text = decode(
                (body.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
                  .map((t) => t.replace(/<[^>]+>/g, ''))
                  .join(''),
              ).trim();
              const rid = body.match(/<w:hyperlink[^>]*r:id="([^"]+)"/)?.[1] ?? null;
              return { text, url: rid ? (rels.get(rid) ?? null) : null };
            }),
        ),
    );
}

/** 按表头内容定位 Supply Seed 表，不写死序号——Brief 改版时序号会变 */
function findSupplyTable(xml: string, rels: Map<string, string>): Row[] {
  const hit = allTables(xml, rels).find(
    (rows) => rows[0]?.[0]?.text === '品类' && rows[0]?.[1]?.text === 'Supplier',
  );
  if (!hit) throw new Error('Brief 里找不到表头为「品类 | Supplier」的 Supply Seed 表');
  return hit;
}

const CATEGORY: Record<string, (typeof DEMAND_CATEGORIES)[number]> = {
  'Man & Van': 'man_and_van',
  Cleaning: 'eot_cleaning',
  'Furniture / Handyman': 'furniture_service',
  // 清运（clearance）在 domain 里同属 furniture_service：AGENTS.md §4.4 禁止二次映射，
  // 所以这里直接落到领域枚举，不另造中间品类。
  'Furniture / Removal': 'furniture_service',
};

/**
 * Brief「特点」列里的 outward code 是**商家所在地**（"E14；07:00-00:00"），不是服务范围。
 * 当成服务范围会让 matcher 的 coversArea 把 E14 以外的需求全部排除，所以它进
 * basePostcode；服务范围默认全伦敦，只有官网写明了片区才收窄（见 verified.json）。
 */
function basePostcode(feature: string): string | null {
  return feature.match(/\b([EWNS][ECWN]?\d{1,2})\b/)?.[1] ?? null;
}

function priceType(price: string): 'hourly' | 'fixed' | 'quote' | null {
  if (/\/h|\/小时|per hour/i.test(price)) return 'hourly';
  if (/^Quote$|在线报价|^$/i.test(price.trim())) return 'quote';
  if (/£/.test(price)) return 'fixed';
  return null;
}

/** 「Contact」列里电话与 WhatsApp 混在一起，按 WhatsApp 关键字拆 */
function contacts(cell: string): { phone: string | null; whatsapp: string | null } {
  const hasWa = /WhatsApp/i.test(cell);
  const numbers = [...cell.matchAll(/(0\d[\d\s]{8,13})/g)].map((m) => m[1]!.replace(/\s+/g, ''));
  return {
    phone: numbers[0] ?? null,
    // Brief 只标了「有 WhatsApp」，没给独立号码：沿用第一个号码，联系时再核实
    whatsapp: hasWa ? (numbers[0] ?? null) : null,
  };
}

const DOCX = 'docs/London_Matching_Bot_Project_Brief.docx';
// Brief 封面「版本：v0.1 / 2026-09-21」。用这一天而不是 now：这批电话与价格是当时核实的，
// 写 now 会让 matcher 的 60 天 stale 降权永远失效（AGENTS.md：不粉饰数据新鲜度）。
const BRIEF_VERIFIED_AT = '2026-09-21';
const relsXml = readDocxXml(DOCX, 'word/_rels/document.xml.rels');
const rels = new Map(
  [...relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*TargetMode="External"/g)].map(
    (m) => [m[1]!, decode(m[2]!)] as const,
  ),
);
const xml = readDocxXml(DOCX, 'word/document.xml');
const rows = findSupplyTable(xml, rels);

const suppliers = rows.slice(1).map((r) => {
  const [catC, nameC, contactC, priceC, featureC, ratingC] = r;
  const cat = catC?.text ?? '';
  // 「Supplier」格里是名字 + 一个文本为 [link] 的超链接，名字要去掉这个占位
  const name = (nameC?.text ?? '').replace(/\s*\[link\]\s*/g, '').trim();
  const contact = contactC?.text ?? '';
  const price = priceC?.text ?? '';
  const feature = featureC?.text ?? '';
  const rating = ratingC?.text ?? '';
  const website = nameC?.url ?? null;
  const category = CATEGORY[cat];
  if (!category) throw new Error(`未知品类: ${cat}（${name}）`);
  if (!name) throw new Error(`第 ${rows.indexOf(r)} 行缺供应商名`);
  const { phone, whatsapp } = contacts(contact);
  return {
    category,
    name,
    phone,
    whatsapp,
    telegram: null,
    website,
    sourceUrl: website,
    serviceArea: ['LONDON'],
    basePostcode: basePostcode(feature),
    priceType: priceType(price),
    roughPrice: price || null,
    isSameDay: /same-?day|24\/7|365/i.test(feature),
    isWeekend: /24\/7|365|周末|weekend|7-day/i.test(feature),
    languages: [],
    // Brief §3 明写「当前均先作为 B 池」；评级只是 BD 优先级提示，不等于 A 池
    pool: 'B' as const,
    isWillingToReceiveLeads: false,
    source: `brief-§3${rating ? ` (${rating})` : ''}`,
    lastVerifiedAt: BRIEF_VERIFIED_AT,
  };
});

process.stdout.write(JSON.stringify({ suppliers, groups: [] }, null, 2) + '\n');
process.stderr.write(`抽出 ${suppliers.length} 家\n`);
