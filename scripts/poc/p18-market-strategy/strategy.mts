import { isActiveMarketListing } from '../../../packages/websearch/src/index.js';
import type { MarketListing, MarketIntent } from '../../../packages/websearch/src/index.js';
export type MarketNeed = { id: string; terms: string[] };
export type MarketPlan = {
  intent: MarketIntent;
  needs: MarketNeed[];
  preferences: string[];
  budget?: number;
  requiredTerms?: string[];
  excludeTerms?: string[];
  dateRange?: { from: string; to: string };
  requiredArea?: string[];
  route?: { from: string[]; to: string[] };
};
export type MarketCheck = {
  label: string;
  status: 'met' | 'unknown' | 'mismatch';
  evidence: string | null;
};
export type MarketAssessment = {
  id: string;
  needs: string[];
  score: number;
  checks: MarketCheck[];
  itemPriceEvidence: string | null;
};
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const contains = (text: string, terms: string[]) =>
  terms.some((term) => norm(text).includes(norm(term)));
const lines = (text: string) =>
  text
    .split(/[\n；;]/u)
    .map((s) => s.trim())
    .filter(Boolean);
function subjectText(n: MarketListing, p: MarketPlan): string {
  const lead = n.description.slice(0, 220);
  const isHousing =
    /^(?:转租|出租|招租|找室友|房源|租房)[：:]|房间出租|房间转租|公寓出租|卧室出租/.test(lead);
  if (p.intent === 'second_hand' && isHousing) return '';
  if (
    p.intent === 'housing' &&
    !isHousing &&
    !/租房|转租|出租|合租|室友|房源|apartment|room for rent/i.test(n.title)
  )
    return '';
  if (p.intent !== 'companion') return n.title + '\n' + n.description;
  // 被邀请的活动才是主体；不能把写在个人背景里的羽毛球爱好当羽毛球邀约。
  const [header = '', original] = n.description.split('——原帖原文——');
  const main = (original ?? header)
    .split('\n')
    .map((s) => s.trim())
    .filter(
      (s) =>
        /^(?:找搭子|活动|内容|项目|招募)[：:]|(?:一起|找.*搭子|求.*搭子|欢迎加入|招新|约球|求.*球|还有.*球)/i.test(
          s,
        ) && !/^个人背景|爱好/.test(s),
    );
  return (
    n.title +
    '\n' +
    (main.length ? main.join('\n') : original === undefined ? header.slice(0, 500) : '')
  );
}
function priceEvidence(
  n: MarketListing,
  p: MarketPlan,
  focusName?: string,
): { text: string; min: number; max: number } | null {
  const textLines = lines(n.description),
    terms = p.needs.flatMap((need) => need.terms);
  const itemLines = textLines.filter((line) =>
    focusName ? contains(line, [focusName]) : contains(line, terms),
  );
  const distinctBulletItems = n.description.split('\n').filter((line) => /^\s*- /.test(line));
  const candidateLines = [
    ...itemLines.filter((line) => /^[-•]/.test(line)),
    ...itemLines.filter((line) => !/^[-•]/.test(line)),
    ...(distinctBulletItems.length <= 1 ? textLines.filter((s) => /^价格[：:]/.test(s)) : []),
  ];
  const priced: Array<{ text: string; min: number; max: number }> = [];
  for (const line of candidateLines) {
    if (/参考价|购入价|原价|新品价|不含|押金|套餐|整套|买.*送|多件|等\d*件|、/.test(line)) continue;
    if (
      p.intent === 'carry' &&
      /\/\s*(?:kg|g|公斤|斤)|(?:每|按).*(?:公斤|斤|重量)|\d+(?:\.\d+)?\s*kg/i.test(line)
    )
      continue;
    if (p.intent === 'housing' && !/\/月|每月|月租|pcm|per month/i.test(line)) continue;
    if (/免费送|免费赠送|free (?:to collect|giveaway)/i.test(line))
      return { text: line, min: 0, max: 0 };
    const amounts = [
      ...line.matchAll(/(?:£|GBP\s*)(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*(?:镑|英镑)/gi),
    ].map((m) => Number(m[1] ?? m[2]));
    const ranges = [
      ...line.matchAll(/(?:£|GBP\s*)(\d+(?:\.\d+)?)\s*[–—-]\s*(?:£)?(\d+(?:\.\d+)?)/g),
    ];
    for (const range of ranges) amounts.push(Number(range[2]));
    if (!amounts.length) continue;
    // 单句多商品价格不能互借；房间的多个价格也只有都明确同一预算时才可判满足。
    if (amounts.length > 2 || /[：:].*(?:锅|桌|椅|灯).*[：:]/.test(line)) continue;
    priced.push({ text: line, min: Math.min(...amounts), max: Math.max(...amounts) });
  }
  return (
    priced.find((price) => p.budget !== undefined && price.max <= p.budget) ?? priced[0] ?? null
  );
}
function routeCheck(n: MarketListing, route: NonNullable<MarketPlan['route']>): MarketCheck {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const from = route.from.map(escape).join('|'),
    to = route.to.map(escape).join('|');
  const forward = new RegExp(
    `(?:${from})[^。，,、；;\\n]{0,24}(?:飞往|飞|到|至|->|→|✈|回)[^。，,、；;\\n]{0,8}(?:${to})`,
    'i',
  );
  const backward = new RegExp(
    `(?:${to})[^。\\n]{0,24}(?:飞往|飞|到|至|->|→|✈|回)[^。\\n]{0,8}(?:${from})`,
    'i',
  );
  const rows = lines(n.title + '\n' + n.description).flatMap((line) => line.split(/[，,]/));
  const met = rows.find((line) => forward.test(line));
  if (met) return { label: 'route', status: 'met', evidence: met };
  const endsAtOrigin = new RegExp(`(?:飞往|飞|到|至|->|→|✈|回)[^。\\n]{0,8}(?:${from})`, 'i');
  const startsAtDestination = new RegExp(`(?:${to})[^。\\n]{0,8}(?:飞往|飞|到|至|->|→|✈)`, 'i');
  const explicitOther = rows.find(
    (line) =>
      /^路线[：:]/.test(line) &&
      contains(line, route.from) &&
      /(?:->|→|至|飞)/.test(line) &&
      !contains(line, route.to) &&
      !/(?:国内|中国|回国|未注明)/.test(line),
  );
  const wrong =
    explicitOther ??
    rows.find(
      (line) => backward.test(line) || endsAtOrigin.test(line) || startsAtDestination.test(line),
    );
  return { label: 'route', status: wrong ? 'mismatch' : 'unknown', evidence: wrong ?? null };
}
export function assessMarketListing(
  n: MarketListing,
  p: MarketPlan,
  focusName?: string,
): MarketAssessment {
  const subject = subjectText(n, p);
  const matchedItems = n.description.split('\n').filter(
    (line) =>
      /^\s*[-•]/.test(line) &&
      contains(
        line,
        p.needs.flatMap((need) => need.terms),
      ),
  );
  const isSold =
    matchedItems.length > 0 && matchedItems.every((line) => /已出|已售|sold|❌/i.test(line));
  const needs = p.needs.filter((need) => contains(subject, need.terms)).map((need) => need.id);
  const checks: MarketCheck[] = [];
  if (n.availableUntil && !isActiveMarketListing(n)) {
    const dates = [
      ...n.description.matchAll(/(?:(20\d{2})[年/-])?(1[0-2]|[1-9])[月./-](3[01]|[12]\d|[1-9])/g),
    ];
    const explicitFuture = dates.some(
      (m) =>
        m[1] &&
        `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` >=
          new Date().toISOString().slice(0, 10),
    );
    const ambiguousTrip = p.intent === 'carry' && new Set(dates.map((m) => m[0])).size > 1;
    checks.push({
      label: 'availability',
      status: explicitFuture || ambiguousTrip ? 'unknown' : 'mismatch',
      evidence: n.availableUntil,
    });
  }
  if (isSold)
    checks.push({ label: 'availability', status: 'mismatch', evidence: matchedItems[0] ?? null });
  if (p.intent === 'companion' && p.preferences.some((term) => /初学|新手|beginner/i.test(term))) {
    const incompatible = lines(n.title + '\n' + n.description).find((line) =>
      /非新手|不收新手|不适合(?:初学|新手)|(?:建议|建議)(?:中阶|中階)以上|中高级|中高級|no beginners|intermediate (?:or|and) above/i.test(
        line,
      ),
    );
    if (incompatible) checks.push({ label: 'skill', status: 'mismatch', evidence: incompatible });
  }
  if (p.requiredTerms?.length) {
    const evidence = lines(subject).find((line) => contains(line, p.requiredTerms!));
    checks.push({
      label: 'required',
      status: evidence ? 'met' : 'unknown',
      evidence: evidence ?? null,
    });
  }
  if (p.excludeTerms?.length) {
    const evidence = lines(subject).find((line) => contains(line, p.excludeTerms!));
    if (evidence) checks.push({ label: 'excluded', status: 'mismatch', evidence });
  }
  const sourceLines = lines(n.description);
  if (p.dateRange) {
    const wantedFrom = p.dateRange.from.slice(5),
      wantedTo = p.dateRange.to.slice(5);
    let dateLines = [
      n.title,
      ...sourceLines.filter((line) => /^(?:时间|帮带|路线)[：:]/.test(line)),
    ];
    if (p.route) {
      const bound = lines(n.title + '\n' + n.description)
        .flatMap((line) => line.split(/[，,]/))
        .filter(
          (line) =>
            contains(line, p.route!.from) &&
            contains(line, p.route!.to) &&
            /飞|至|->|→|✈/.test(line) &&
            /\d{1,2}[月./-]\d{1,2}/.test(line) &&
            !/kg|公斤|rmb|(?:费用|价格)[：:]/i.test(line),
        );
      if (bound.length) dateLines = bound;
    }
    if (p.route) {
      const destination = p.route.to
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const arrival = new RegExp(
        `(?:(20\\d{2})[年/-])?(\\d{1,2})[月./-](\\d{1,2})\\s*✈(?:️)?\\s*(?:${destination})`,
        'gi',
      );
      const arrived = sourceLines.filter((line) => {
        arrival.lastIndex = 0;
        return arrival.test(line);
      });
      if (arrived.length)
        dateLines = arrived.map((line) => {
          arrival.lastIndex = 0;
          return [...line.matchAll(arrival)].map((m) => m[0]).join('；');
        });
    }
    const dated = dateLines.flatMap((line) =>
      [...line.matchAll(/(?:(20\d{2})[年/-])?(\d{1,2})[月./-](\d{1,2})/g)]
        .filter(
          (m) =>
            Number(m[2]) >= 1 &&
            Number(m[2]) <= 12 &&
            Number(m[3]) >= 1 &&
            Number(m[3]) <= 31 &&
            !/^(?:\s*(?:\/\s*)?(?:kg|公斤|g|斤|镑|rmb|cm))/i.test(
              line.slice((m.index ?? 0) + m[0].length),
            ),
        )
        .map((m) => ({
          line,
          year: m[1],
          md: `${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`,
        })),
    );
    const valid = dated.filter((d) =>
      d.year
        ? `${d.year}-${d.md}` >= p.dateRange!.from && `${d.year}-${d.md}` <= p.dateRange!.to
        : wantedFrom <= wantedTo
          ? d.md >= wantedFrom && d.md <= wantedTo
          : d.md >= wantedFrom || d.md <= wantedTo,
    );
    const months = dateLines.flatMap((line) =>
      [...line.matchAll(/(\d{1,2})月(?:初|底|末|上旬|中旬|下旬)/g)].map((m) => Number(m[1])),
    );
    const fromMonth = Number(wantedFrom.slice(0, 2)),
      toMonth = Number(wantedTo.slice(0, 2));
    const wrongMonth =
      !dated.length &&
      months.length > 0 &&
      months.every((month) =>
        fromMonth <= toMonth
          ? month < fromMonth || month > toMonth
          : month < fromMonth && month > toMonth,
      );
    checks.push({
      label: 'date',
      status:
        (dated.length && !valid.length) || wrongMonth
          ? 'mismatch'
          : valid.some(
                (d) =>
                  d.year &&
                  `${d.year}-${d.md}` >= p.dateRange!.from &&
                  `${d.year}-${d.md}` <= p.dateRange!.to,
              )
            ? 'met'
            : 'unknown',
      evidence: valid[0]?.line ?? dated[0]?.line ?? null,
    });
  }
  if (
    p.dateRange &&
    n.availableUntil &&
    n.availableUntil.slice(0, 10) < p.dateRange.from &&
    checks.some((c) => c.label === 'date' && c.status !== 'mismatch')
  )
    checks.push({ label: 'date_conflict', status: 'unknown', evidence: n.availableUntil });
  if (p.requiredArea?.length) {
    const locations = sourceLines.filter(
      (line) =>
        /(?:^|\s)(?:地点|位置|地址|交接)[：:]|自提|自取|面交/.test(line) ||
        (p.intent === 'housing' && /^(?:出租|转租|合租|找室友)[：:]/.test(line)),
    );
    const actual = locations.find((line) => contains(line, p.requiredArea!));
    const outcodes = (text: string) =>
      [...text.matchAll(/\b(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?\b/gi)].map((m) =>
        m[0].toUpperCase(),
      );
    const requestedCodes = p.requiredArea.flatMap(outcodes),
      foundCodes = locations.flatMap(outcodes);
    const knownConflict =
      requestedCodes.length > 0 &&
      foundCodes.length > 0 &&
      !foundCodes.some((code) => requestedCodes.includes(code));
    checks.push({
      label: 'area',
      status: knownConflict ? 'mismatch' : actual ? 'met' : 'unknown',
      evidence: actual ?? locations[0] ?? null,
    });
  }
  const price = priceEvidence(n, p, focusName);
  if (p.budget !== undefined)
    checks.push({
      label: 'budget',
      status: price
        ? /左右|大约|约(?:£|\d)|起价|起步|起$|approx|around/i.test(price.text)
          ? 'unknown'
          : n.tradeType === 'BUY'
            ? price.min >= p.budget
              ? 'met'
              : price.max < p.budget
                ? 'mismatch'
                : 'unknown'
            : price.max <= p.budget
              ? 'met'
              : price.min > p.budget
                ? 'mismatch'
                : 'unknown'
        : 'unknown',
      evidence: price?.text ?? null,
    });
  if (p.route) checks.push(routeCheck(n, p.route));
  const preferenceSource = focusName && matchedItems.length ? matchedItems.join('\n') : subject;
  for (const preference of p.preferences) {
    if (!contains(preferenceSource, [preference]))
      checks.push({ label: `preference:${preference}`, status: 'unknown', evidence: null });
  }
  const met = checks.filter((c) => c.status === 'met').length,
    wrong = checks.filter((c) => c.status === 'mismatch').length;
  const titleHits = p.needs.reduce(
    (count, need) => count + Number(contains(n.title, need.terms)),
    0,
  );
  const preferences = p.preferences.filter((term) => contains(subject, [term])).length;
  return {
    id: n.id,
    needs,
    checks,
    itemPriceEvidence: price?.text ?? null,
    score:
      Number(!checks.some((c) => c.status !== 'met')) * 12 +
      needs.length * 30 +
      titleHits * 4 +
      met * 10 +
      preferences * 2 -
      wrong * 80,
  };
}
export function rankMarketListings<T extends MarketListing>(
  listings: T[],
  plan: MarketPlan,
  limit = 40,
): Array<{ listing: T; assessment: MarketAssessment }> {
  const ranked = listings
    .map((listing) => ({ listing, assessment: assessMarketListing(listing, plan) }))
    .filter((r) => r.assessment.needs.length)
    .sort(
      (a, b) => b.assessment.score - a.assessment.score || a.listing.id.localeCompare(b.listing.id),
    );
  const selected: typeof ranked = [];
  // 先覆盖用户要找的每一种物品/活动，再填同类候选，避免前一个热词占满名额。
  for (const need of plan.needs) {
    const first = ranked.find(
      (r) =>
        r.assessment.needs.includes(need.id) &&
        !selected.some((s) => s.listing.id === r.listing.id) &&
        !r.assessment.checks.some((c) => c.status === 'mismatch'),
    );
    if (first) selected.push(first);
  }
  for (const row of ranked)
    if (!selected.some((s) => s.listing.id === row.listing.id) && selected.length < limit)
      selected.push(row);
  return selected.slice(0, limit);
}
