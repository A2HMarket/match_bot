/**
 * P14 PoC：库里没有时用 Tavily 搜，搜到的结果能核验出多少可用商家。
 *   set -a; . ./.env; set +a; pnpm exec tsx scripts/poc/p14-search/run.mts <out.json>
 * 查询是 agent 会产出的「服务 + 区域」形态，不含任何用户原话（Tavily 会留存查询）。
 */
import { writeFileSync } from 'node:fs';

const QUERIES = [
  'locksmith Stratford E15 London',
  'emergency plumber SE1 London',
  'electrician Camden NW1 London',
  'boiler repair Canary Wharf E14 London',
  'phone screen repair W1 London',
  'bike repair shop Islington N1 London',
  'Mandarin speaking dentist London',
  'Chinese supermarket Battersea SW11 London',
  'key cutting Whitechapel E1 London',
  'tailor clothing alterations Paddington W2 London',
  'vet clinic Greenwich SE10 London',
  'piano tuner London',
  'certified translation Chinese to English London',
  'Mandarin speaking driving instructor London',
  'custom birthday cake Chinese bakery London',
  'carpet cleaning Bow E3 London',
  'pest control mice Holloway N7 London',
  'Chinese hairdresser Soho London',
  'TV wall mounting Wandsworth SW18 London',
  'short term self storage E16 London',
];

// 聚合站 / 目录站 / 平台：不是商家自己的站，不能按「官网有电话」核验
const DIRECTORY =
  /(^|\.)(checkatrade|trustatrader|yell|yelp|tripadvisor|bark|mybuilder|ratedpeople|trustpilot|google|facebook|instagram|reddit|nextdoor|thomsonlocal|192|freeindex|cylex|scoot|hotfrog|timeout|gumtree|airtasker|taskrabbit|treatwell|fresha|booksy|nhs|wikipedia|amazon|youtube|tiktok|linkedin|x|twitter|quora|mumsnet|londonist|secretldn|thefork|opentable|deliveroo|ubereats|justeat|zoopla|rightmove|companieshouse|find-and-update\.company-information\.service)\.(com|co\.uk|org|uk|gov\.uk|net)$/i;

const UA = 'Mozilla/5.0 (compatible; matchbot-p14-poc/0.1)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(url: string): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: ac.signal });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
const plain = (h: string) =>
  h
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
const norm = (x: string) => {
  const d = x.replace(/[^\d+]/g, '');
  return d.startsWith('+44')
    ? '0' + d.slice(3)
    : d.startsWith('44') && d.length > 11
      ? '0' + d.slice(2)
      : d;
};

const out: unknown[] = [];
let credits = 0;
for (const q of QUERIES) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SEARCH_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: q,
      search_depth: 'basic',
      max_results: 8,
      country: 'united kingdom',
    }),
  });
  credits++;
  const j = (await res.json()) as {
    results?: { url: string; title: string; content: string; score: number }[];
  };
  const rows = [];
  for (const r of j.results ?? []) {
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    const isDir = DIRECTORY.test(host);
    let phones: string[] = [];
    let london = false;
    let fetched = false;
    if (!isDir) {
      const html = await get(r.url);
      await sleep(800);
      if (html) {
        fetched = true;
        const t = plain(html);
        const tel = [...html.matchAll(/href=["']tel:([^"']+)/gi)].map((m) =>
          norm(decodeURIComponent(m[1]!)),
        );
        const txt = (t.match(/(?:\+44\s?\(?0?\)?|\b0)\d[\d\s\-()]{8,13}\d/g) ?? []).map(norm);
        phones = [...new Set([...tel, ...txt])].filter((p) => /^0\d{10}$/.test(p));
        london = /\bLondon\b/i.test(t) || /\b(E|EC|N|NW|SE|SW|W|WC)\d{1,2}[A-Z]?\b/.test(t);
      }
    }
    rows.push({
      host,
      url: r.url,
      title: r.title.slice(0, 80),
      score: r.score,
      isDir,
      fetched,
      phones: phones.slice(0, 3),
      london,
      usable: !isDir && fetched && phones.length > 0 && london,
    });
  }
  const usable = rows.filter((r) => r.usable).length;
  process.stderr.write(`${String(usable).padStart(2)} usable / ${rows.length}  ${q}\n`);
  out.push({ q, rows });
  await sleep(500);
}
writeFileSync(process.argv[2]!, JSON.stringify({ credits, out }, null, 1));
process.stderr.write(`credits used: ${credits}\n`);
