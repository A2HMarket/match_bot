/**
 * 访问 30 家供应商的官网，核实并补全联系方式、服务区域与评价。
 *
 *   pnpm exec tsx scripts/seed/enrich-suppliers.ts scripts/seed/data.json
 *
 * 只抓各家**自己官网**上公开发布的信息（他们主动公示的联系方式与评价角标），
 * 不去聚合平台爬第三方内容。已核对这些站点的 robots.txt 允许通用抓取。
 * 顺序请求 + 间隔，避免给小商家的站点造成压力。
 *
 * 合并原则：Brief §3 是人工整理过的，**不被自动结果覆盖**；官网只用于补空缺，
 * 以及修正那些本来就是猜的字段（whatsapp 之前是拿电话凑的）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; matchbot-supplier-verify/0.1; +contact via repo owner)';
const DELAY_MS = 1500;
const TIMEOUT_MS = 25_000;

type Supplier = {
  name: string;
  website: string | null;
  phone: string | null;
  email?: string | null;
  whatsapp: string | null;
  serviceArea: string[];
  rating?: number | null;
  reviewCount?: number | null;
  [k: string]: unknown;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: ac.signal,
      redirect: 'follow',
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function toPlain(html: string): string {
  const noScript = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return unescapeHtml(noScript.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

/** 英国号码归一成纯数字，便于比对；保留前导 0 / 44 的差异由调用方处理 */
function normPhone(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  return d.startsWith('+44')
    ? '0' + d.slice(3)
    : d.startsWith('44') && d.length > 11
      ? '0' + d.slice(2)
      : d;
}

function extract(html: string) {
  const plain = toPlain(html);
  const phones = [
    ...new Set(
      (plain.match(/(?:\+44|0)\d[\d\s\-()]{8,14}\d/g) ?? [])
        .map(normPhone)
        .filter((p) => p.length >= 10 && p.length <= 12),
    ),
  ];
  const emails = [
    ...new Set(
      (plain.match(/[\w.\-]+@[\w.\-]+\.[a-z]{2,}/gi) ?? [])
        .map((e) => e.toLowerCase())
        // 过滤掉图片/资源里混出来的假邮箱
        .filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/i.test(e)),
    ),
  ];
  const wa = [
    ...new Set(html.match(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{8,15})/g) ?? []),
  ]
    .map((m) => m.replace(/\D/g, ''))
    .map((d) => (d.startsWith('44') ? '0' + d.slice(2) : d));
  const postcodes = [...new Set(plain.match(/\b([EWNS][CEWN]?\d{1,2})\b(?=[\s,.)]|$)/g) ?? [])];
  const ratingM = plain.match(/(\d\.\d)\s*(?:\/\s*5|out of 5|star)/i);
  const countM = plain.match(/([\d,]{2,9})\s*(?:\+\s*)?(?:reviews?|ratings?|customers?)/i);
  return {
    phones,
    email: emails[0] ?? null,
    whatsapp: wa[0] ?? null,
    postcodes,
    rating: ratingM ? Number(ratingM[1]) : null,
    reviewCount: countM ? Number(countM[1]!.replace(/,/g, '')) : null,
  };
}

const path = process.argv[2];
if (!path) throw new Error('usage: tsx scripts/seed/enrich-suppliers.ts <data.json>');
const file = JSON.parse(readFileSync(path, 'utf8')) as { suppliers: Supplier[]; groups: unknown[] };

let ok = 0;
const report: string[] = [];
for (const [i, s] of file.suppliers.entries()) {
  if (!s.website) {
    report.push(`${s.name}: 无官网，跳过`);
    continue;
  }
  const html = await fetchText(s.website);
  await sleep(DELAY_MS);
  if (!html) {
    report.push(`${s.name}: 抓取失败（超时或非 200）`);
    continue;
  }
  ok++;
  const e = extract(html);
  const got: string[] = [];

  // Brief 的电话不动，只在官网出现同号时算作“已核实”
  const briefPhone = s.phone ? normPhone(s.phone) : null;
  const phoneConfirmed = briefPhone
    ? e.phones.some((p) => p.endsWith(briefPhone.slice(-9)))
    : false;
  s.phoneVerified = phoneConfirmed;
  if (phoneConfirmed) got.push('phone✓');
  else if (briefPhone) got.push('phone✗');

  // 对「官网是自动搜出来的」那 16 家，电话同时充当**身份验证**：页面上找不到 Brief 记录的
  // 号码，就说明搜到的站可能根本不是这一家（例如同名的 London, Ontario 商家）。
  // 这种情况下一律不采信页面内容，标记出来交人工核。
  if (s.websiteDiscovered === true && !phoneConfirmed) {
    s.needsHumanCheck = '官网由自动搜索得到，且页面未出现 Brief 记录的电话，归属存疑';
    report.push(`${String(i + 1).padStart(2)}. ${s.name}: ⚠ 归属存疑，不采信（${s.website}）`);
    continue;
  }

  if (!s.email && e.email) {
    s.email = e.email;
    got.push('email+');
  }
  // 之前 whatsapp 是拿电话猜的，官网给出真号就以官网为准
  if (e.whatsapp && e.whatsapp !== s.whatsapp) {
    s.whatsapp = e.whatsapp;
    got.push('whatsapp✎');
  }
  if (e.postcodes.length >= 3 && s.serviceArea.join() === 'LONDON') {
    s.serviceArea = [...e.postcodes.slice(0, 12), 'LONDON'];
    got.push(`area+${e.postcodes.length}`);
  }
  if (e.rating && e.rating >= 1 && e.rating <= 5) {
    s.rating = e.rating;
    got.push(`rating ${e.rating}`);
  }
  if (e.reviewCount && e.reviewCount >= 3) {
    s.reviewCount = e.reviewCount;
    got.push(`reviews ${e.reviewCount}`);
  }
  report.push(`${String(i + 1).padStart(2)}. ${s.name}: ${got.join(' ') || '无新增'}`);
}

writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
process.stderr.write(report.join('\n') + `\n\n抓取成功 ${ok}/${file.suppliers.length}\n`);
