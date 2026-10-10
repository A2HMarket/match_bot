import type { Logger } from '@matchbot/shared';
import { z } from 'zod';
import { assertSafeXhsKeyword } from './query.js';

export const MARKET_INTENTS = ['second_hand', 'housing', 'carry', 'companion'] as const;
export type MarketIntent = (typeof MARKET_INTENTS)[number];
export const MARKET_TRADE_TYPES = ['SELL', 'BUY', 'PEER', 'ANY'] as const;
export type MarketTradeType = (typeof MARKET_TRADE_TYPES)[number];
const dateSchema = z.iso.datetime({ offset: true }).nullable().optional();
const availabilitySchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const rawListingSchema = z.object({
  listingId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string(),
  description: z.string().nullable().default(''),
  tags: z.array(z.string()).default([]),
  tradeType: z.enum(['SELL', 'BUY', 'PEER']),
  status: z.string().regex(/^[A-Z_]{1,30}$/),
  postType: z.string().default(''),
  repost: z.boolean().default(false),
  price: z.number().finite().nonnegative().nullable().optional(),
  priceMin: z.number().finite().nonnegative().nullable().optional(),
  priceMax: z.number().finite().nonnegative().nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  priceUnit: z.string().max(40).nullable().optional(),
  availableFrom: availabilitySchema.nullable().optional(),
  availableUntil: availabilitySchema.nullable().optional(),
  sourcePublishedAt: dateSchema,
  createdAt: dateSchema,
  updatedAt: dateSchema,
  sourceUrl: z.string().nullable().optional(),
});
const listResponseSchema = z.object({
  code: z.literal('OK'),
  data: z.object({
    page: z.number().int().positive(),
    size: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    hasNext: z.boolean(),
    items: z.array(rawListingSchema),
  }),
});
const detailResponseSchema = z.object({ code: z.literal('OK'), data: rawListingSchema });
export const marketListingSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  tradeType: z.enum(['SELL', 'BUY', 'PEER']),
  status: z.string(),
  url: z.url(),
  sourceUrl: z.url().nullable(),
  isRepost: z.boolean(),
  priceLabel: z.string(),
  availableFrom: availabilitySchema.nullable(),
  availableUntil: availabilitySchema.nullable(),
  sourcePublishedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }).nullable(),
});
export type MarketListing = z.infer<typeof marketListingSchema>;
export type MarketSearch = {
  find(p: {
    keyword: string;
    page: number;
    tradeType: MarketTradeType;
  }): Promise<{ items: MarketListing[]; hasNext: boolean; total: number }>;
  detail(id: string): Promise<MarketListing>;
};
export class MarketSearchError extends Error {
  constructor(
    readonly reason: 'timeout' | 'http_error' | 'invalid_response',
    readonly status?: number,
    readonly fields?: string[],
  ) {
    super(`market search failed: ${reason}`);
    this.name = 'MarketSearchError';
  }
}

/** 公共帖子也可能带联系方式；不给模型、不进群回复或快照，原文由用户自行点开。 */
export function redactMarketText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[联系方式已隐藏]')
    .replace(/(?:\+?(?:44|86)[\d ()-]{8,}\d|\b0\d[\d ()-]{7,}\d\b)/g, '[联系方式已隐藏]')
    .replace(
      /(?:微信|微.?信号|wechat|whatsapp|telegram|\bvx\b|\bv信\b)\s*(?:号|联系|id)?\s*[:：=]?\s*[@\p{L}\p{N}_.-]+/giu,
      '[联系方式已隐藏]',
    )
    .replace(/@[A-Za-z0-9_]{3,}/g, '[联系方式已隐藏]')
    .replace(/https?:\/\/[^\s<>]+/gi, '[原文链接已隐藏]')
    .replace(/\*\*/g, '');
}
const LONDON =
  /伦敦|倫敦|\bLondon\b|\b(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?\b|\b(?:Camberwell|Battersea|Stratford|Canary Wharf|Wembley|Camden|Archway|Vauxhall|Ilford|Leyton|Croydon|Southbank|Soho|UCL|LSE|KCL|Greenwich|Islington|Willesden|Kings\s*Cross)\b/i;
export const hasLondonEvidence = (listing: MarketListing) =>
  LONDON.test([listing.title, listing.description, ...listing.tags].join('\n'));
/** 日期型可用期按伦敦本地日历日判断，时间戳型按瞬间判断。 */
export function isActiveMarketListing(listing: MarketListing, now = new Date()): boolean {
  if (listing.status !== 'ON_SALE') return false;
  // 转载库存可能滞后；原文明确宣布整帖已结束时，不能只信 ON_SALE 标记。
  if (
    /(?:^|\n)\s*(?:已出|已售|已售出|已租|已租出|sold(?: out)?|no longer available)\s*[。.!！✓✅✔]*\s*(?:$|\n)/iu.test(
      listing.description,
    )
  )
    return false;
  if (!listing.availableUntil) return true;
  if (listing.availableUntil.length === 10) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const field = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return listing.availableUntil >= `${field('year')}-${field('month')}-${field('day')}`;
  }
  return Date.parse(listing.availableUntil) >= now.getTime();
}

function safeSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'www.xiaohongshu.com' &&
      /^\/(explore|discovery\/item)\/[\w-]+$/.test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
function priceLabel(raw: z.infer<typeof rawListingSchema>): string {
  const symbol =
    raw.currency === 'GBP'
      ? '£'
      : raw.currency === 'EUR'
        ? '€'
        : raw.currency === 'USD'
          ? '$'
          : raw.currency === 'CNY'
            ? '¥'
            : raw.currency
              ? `${raw.currency} `
              : '';
  const unit = raw.priceUnit ? `/${redactMarketText(raw.priceUnit)}` : '';
  if (raw.priceMin != null && raw.priceMax != null && raw.priceMin !== raw.priceMax)
    return `帖内报价范围：${symbol}${raw.priceMin}–${symbol}${raw.priceMax}${unit}（单品价格需确认）`;
  const price = raw.price ?? raw.priceMin ?? raw.priceMax;
  return price == null
    ? '帖子未标价'
    : `帖子标价：${symbol}${price}${unit}（具体对象/计价单位请确认）`;
}
function normalizeListing(raw: z.infer<typeof rawListingSchema>): MarketListing {
  return marketListingSchema.parse({
    id: raw.listingId,
    title: redactMarketText(raw.title).slice(0, 160),
    description: redactMarketText(raw.description ?? '').slice(0, 2800),
    tags: raw.tags.map(redactMarketText).slice(0, 30),
    tradeType: raw.tradeType,
    status: raw.status,
    url: `https://a2hmarket.ai/listings/${raw.listingId}`,
    sourceUrl: safeSourceUrl(raw.sourceUrl),
    isRepost: raw.repost || raw.postType === 'REPOST_XHS',
    priceLabel: priceLabel(raw),
    availableFrom: raw.availableFrom ?? null,
    availableUntil: raw.availableUntil ?? null,
    sourcePublishedAt: raw.sourcePublishedAt ?? null,
    createdAt: raw.createdAt ?? null,
  });
}

/** P16：固定公开 GET 路径。响应先校验，失败不伪装成“没有货”。 */
export function createMarketSearch(p: { logger: Logger; fetchImpl?: typeof fetch }): MarketSearch {
  const fetchImpl = p.fetchImpl ?? fetch;
  async function get(url: URL): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url.toString(), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          try {
            return await res.json();
          } catch {
            throw new MarketSearchError('invalid_response');
          }
        }
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        throw new MarketSearchError('http_error', res.status);
      } catch (error) {
        if (error instanceof MarketSearchError) throw error;
        if (attempt === 1)
          throw new MarketSearchError(
            error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'http_error',
          );
      }
    }
    throw new MarketSearchError('http_error');
  }
  const base = 'https://a2hmarket.ai/a2h-post/api/v1/public/listings';
  return {
    async find(q) {
      const keyword = assertSafeXhsKeyword(q.keyword);
      const page = z.number().int().min(1).max(3).parse(q.page);
      const tradeType = z.enum(MARKET_TRADE_TYPES).parse(q.tradeType);
      const url = new URL(base);
      url.search = new URLSearchParams({
        keyword,
        page: String(page),
        size: '20',
        ...(tradeType === 'ANY' ? {} : { tradeType }),
      }).toString();
      const parsed = listResponseSchema.safeParse(await get(url));
      if (!parsed.success)
        throw new MarketSearchError(
          'invalid_response',
          undefined,
          parsed.error.issues.map((issue) => issue.path.join('.')),
        );
      const seen = new Set<string>();
      const items = parsed.data.data.items.map(normalizeListing).filter((item) => {
        if (
          seen.has(item.id) ||
          !isActiveMarketListing(item) ||
          !hasLondonEvidence(item) ||
          (tradeType !== 'ANY' && item.tradeType !== tradeType)
        )
          return false;
        seen.add(item.id);
        return true;
      });
      p.logger.info(
        { page, total: parsed.data.data.total, eligible: items.length },
        'public market search completed',
      );
      return { items, hasNext: parsed.data.data.hasNext, total: parsed.data.data.total };
    },
    async detail(id) {
      const safeId = z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,100}$/)
        .parse(id);
      const parsed = detailResponseSchema.safeParse(
        await get(new URL(`${base}/${encodeURIComponent(safeId)}`)),
      );
      if (!parsed.success || parsed.data.data.listingId !== safeId)
        throw new MarketSearchError('invalid_response');
      return normalizeListing(parsed.data.data);
    },
  };
}
