import type { Logger } from '@matchbot/shared';
import { extractContacts, looksLikeListicle, nameFromTitle } from './extract.js';
import { buildSearchQuery } from './query.js';

export interface SearchCandidate {
  /** 本次搜索内的编号（w1…）。回复工具只认编号，模型写不进结果以外的商家。 */
  ref: string;
  name: string;
  url: string;
  contact: { phone?: string; whatsapp?: string; instagram?: string };
  /** 核验依据，写进 trace 与工具返回，便于抽查。 */
  evidence: 'contact_on_own_site' | 'instagram_profile';
}

export interface WebSearch {
  find(p: { need: string; area?: string | undefined }): Promise<SearchCandidate[]>;
}

interface TavilyResult {
  url: string;
  title: string;
  content: string;
}

const TAVILY_URL = 'https://api.tavily.com/search';
const MAX_CANDIDATES = 5;

/**
 * 目录、点评、撮合平台与社交网站：页面上的电话不属于某一家商家，不能按自有站核验。
 * Instagram 例外，单独按主页处理（P14 方案 B：华人店铺多只在 Instagram 上留联系方式）。
 * 名单来自 P14 PoC 里实际出现的干扰项。
 */
const NOT_A_BUSINESS_SITE =
  /(^|\.)(checkatrade|trustatrader|yell|yelp|tripadvisor|bark|mybuilder|ratedpeople|trustpilot|google|facebook|reddit|nextdoor|thomsonlocal|freeindex|cylex-uk|cylex|scoot|hotfrog|timeout|gumtree|airtasker|taskrabbit|treatwell|fresha|booksy|nhs|wikipedia|amazon|youtube|tiktok|linkedin|twitter|x|quora|mumsnet|londonist|secretldn|thatsup|thefork|opentable|deliveroo|ubereats|justeat|zoopla|rightmove|hamuch|housekeep|drivingschoolstop|comparethestorage|wheree|goroadie|brentcross|westfield|gov|gq-magazine|vogue|esquire|harpersbazaar|cntraveller|standard|thetimes|theguardian|telegraph|independent|bbc|dailymail|mylondon|visitlondon|designmynight|hotdinners|squaremeal|eater|culturetrip|lonelyplanet|medium|substack|blogspot|wordpress)\.[a-z.]+$/i;

/** 文章 / 资讯 / 博客页：页面上有电话也不代表它是一家商家（实测 GQ 杂志的一篇文章通过了核验）。 */
const EDITORIAL_PATH =
  /\/(article|articles|news|blog|blogs|story|stories|magazine|lifestyle|features?|guides?|listings?|best-[a-z-]+)(\/|-|$)/i;

/** 不用抓页面就能判定「不是一家商家的站」的结果。Instagram 主页另行处理，不在此列。 */
function rejectWithoutFetching(r: TavilyResult): boolean {
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return true;
  }
  if (INSTAGRAM_PROFILE.test(r.url)) return false;
  return (
    NOT_A_BUSINESS_SITE.test(u.hostname.replace(/^www\./, '')) ||
    EDITORIAL_PATH.test(u.pathname) ||
    looksLikeListicle(r.title)
  );
}

const INSTAGRAM_PROFILE = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})\/?$/i;

/**
 * 库里没有合适商家时的兜底搜索（P14）。搜 → 剔除非商家站 → 逐个核验：
 * - 自有站：页面上有英国电话 / WhatsApp / Instagram 之一，且提到伦敦；
 * - Instagram 主页：标题或摘要提到伦敦（主页本身要登录才能看，只能凭搜索摘要）。
 * 只返回结构化字段，网页正文不交给模型（防注入，P14 §1 第 3 条）。
 */
export function createWebSearch(p: {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  pageTimeoutMs?: number;
}): WebSearch {
  const fetchImpl = p.fetchImpl ?? fetch;
  const pageTimeoutMs = p.pageTimeoutMs ?? 8000;

  async function tavily(query: string): Promise<TavilyResult[]> {
    // PoC 里出现过一次无报错的空结果、重试即正常，所以空结果也重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(TAVILY_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            query,
            search_depth: 'basic',
            max_results: 8,
            country: 'united kingdom',
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const j = (await res.json()) as { results?: TavilyResult[] };
          if (j.results?.length) return j.results;
        } else {
          p.logger.warn({ status: res.status }, 'tavily search failed');
        }
      } catch (e) {
        p.logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'tavily search error');
      }
    }
    return [];
  }

  async function page(url: string): Promise<string | null> {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; matchbot/0.1)' },
        signal: AbortSignal.timeout(pageTimeoutMs),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  async function verify(r: TavilyResult): Promise<Omit<SearchCandidate, 'ref'> | null> {
    const ig = INSTAGRAM_PROFILE.exec(r.url);
    if (ig) {
      const blurb = `${r.title} ${r.content}`;
      if (!/\bLondon\b|伦敦|倫敦/i.test(blurb)) return null;
      const name =
        r.title
          .split(/\s*\(@/)[0]!
          .split(/\s[•|]\s/)[0]!
          .trim() || ig[1]!;
      return {
        name: name.slice(0, 60),
        url: `https://www.instagram.com/${ig[1]}/`,
        contact: { instagram: ig[1]! },
        evidence: 'instagram_profile',
      };
    }
    const html = await page(r.url);
    if (!html) return null;
    const c = extractContacts(html);
    if (!c.mentionsLondon) return null;
    const contact = {
      ...(c.phones[0] ? { phone: c.phones[0] } : {}),
      ...(c.whatsapp ? { whatsapp: c.whatsapp } : {}),
      ...(c.instagram ? { instagram: c.instagram } : {}),
    };
    if (Object.keys(contact).length === 0) return null;
    return {
      name: (c.siteName ?? nameFromTitle(r.title)).slice(0, 60),
      url: r.url,
      contact,
      evidence: 'contact_on_own_site',
    };
  }

  return {
    async find(q) {
      const query = buildSearchQuery(q);
      const results = await tavily(query);
      // 先做不联网的剔除，再按域名去重：反过来的话，同一家店的博客页若排在首页前面，
      // 会先占掉该域名的名额再被剔除，把真正的首页一起丢掉（测试里复现过）。
      const plausible = results.filter((r) => !rejectWithoutFetching(r));
      const seen = new Set<string>();
      const unique = plausible.filter((r) => {
        let key: string;
        try {
          const u = new URL(r.url);
          key = INSTAGRAM_PROFILE.test(r.url) ? u.pathname.toLowerCase() : u.hostname;
        } catch {
          return false;
        }
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const verified = await Promise.all(unique.map(verify));
      const out = verified
        .filter((v): v is Omit<SearchCandidate, 'ref'> => v !== null)
        .slice(0, MAX_CANDIDATES)
        .map((v, i) => ({ ...v, ref: `w${i + 1}` }));
      p.logger.info({ results: results.length, verified: out.length }, 'web search done');
      return out;
    },
  };
}
