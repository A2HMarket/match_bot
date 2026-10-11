import { describe, expect, it, vi } from 'vitest';
import { createMarketSearch, isActiveMarketListing } from '../src/market.js';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const listing = (over: Record<string, unknown> = {}) => ({
  listingId: 'listing_a',
  title: '伦敦 小绿锅',
  description: 'Camberwell 自提。小绿锅成色新，£15。微信：abc123，电话 07700 900123',
  tags: ['物品交易', '厨房'],
  tradeType: 'SELL',
  status: 'ON_SALE',
  price: null,
  priceMin: 5,
  priceMax: 80,
  currency: 'GBP',
  priceUnit: null,
  postType: 'REPOST_XHS',
  sourceUrl: 'https://www.xiaohongshu.com/discovery/item/n1?xsec_token=tok',
  createdAt: '2026-10-01T00:00:00Z',
  sourcePublishedAt: '2026-09-01T00:00:00Z',
  ...over,
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ code: 'OK', data }), {
    headers: { 'content-type': 'application/json' },
  });
const searchBody = (items: unknown[]) => ({
  page: 1,
  size: 20,
  total: items.length,
  hasNext: true,
  items,
});

describe('createMarketSearch', () => {
  it('treats a null repost marker as absent without discarding legitimate self-posted results', async () => {
    const client = createMarketSearch({
      logger,
      fetchImpl: () =>
        Promise.resolve(
          response(
            searchBody([
              listing({ repost: null, postType: 'USER' }),
              listing({ listingId: 'listing_b' }),
            ]),
          ),
        ),
    });
    const out = await client.find({ keyword: '小绿锅', page: 1, tradeType: 'SELL' });
    expect(out.items).toHaveLength(2);
    expect(out.items[0]?.isRepost).toBe(false);
  });
  it('preserves the public fallback notice as redacted, untrusted source metadata', async () => {
    const client = createMarketSearch({
      logger,
      fetchImpl: () =>
        Promise.resolve(
          response({
            ...searchBody([listing()]),
            notice: '已放宽地点条件，微信：abc123',
          }),
        ),
    });
    const result = await client.find({ keyword: '小绿锅 Camberwell', page: 1, tradeType: 'SELL' });
    expect(result.notice).toContain('已放宽地点条件');
    expect(result.notice).not.toContain('abc123');
  });
  it('recalls a visible post despite a past imported availability field for strategy assessment', async () => {
    const client = createMarketSearch({
      logger,
      fetchImpl: () =>
        Promise.resolve(response(searchBody([listing({ availableUntil: '2020-01-01' })]))),
    });
    expect(
      (await client.find({ keyword: '小绿锅', page: 1, tradeType: 'SELL' })).items,
    ).toHaveLength(1);
  });
  it('accepts real PEER companion posts and filters out BUY/SELL goods for a PEER query', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        response(
          searchBody([
            listing(),
            listing({
              listingId: 'listing_peer',
              title: '伦敦网球搭子',
              description: '伦敦想找人一起打网球。',
              tradeType: 'PEER',
            }),
          ]),
        ),
      ),
    );
    const out = await createMarketSearch({ logger, fetchImpl }).find({
      keyword: '网球',
      page: 1,
      tradeType: 'PEER',
    });
    expect(out.items.map((item) => item.id)).toEqual(['listing_peer']);
    const [input] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(input).searchParams.get('tradeType')).toBe('PEER');
  });
  it('uses the exact public API, sends trade direction and paging without cookies, sanitizes contacts and preserves source links', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response(searchBody([listing()]))));
    const out = await createMarketSearch({ logger, fetchImpl }).find({
      keyword: '小绿锅',
      page: 2,
      tradeType: 'SELL',
    });
    const [input, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe('https://a2hmarket.ai/a2h-post/api/v1/public/listings');
    expect(url.searchParams.get('tradeType')).toBe('SELL');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('size')).toBe('20');
    expect(options.headers).not.toHaveProperty('cookie');
    expect(out.hasNext).toBe(true);
    expect(out.items[0]?.description).not.toContain('abc123');
    expect(out.items[0]?.description).not.toContain('07700');
    expect(out.items[0]?.sourceUrl).toContain('xsec_token=tok');
    expect(out.items[0]?.url).toBe('https://a2hmarket.ai/listings/listing_a');
    expect(out.items[0]).not.toHaveProperty('posterUserId');
    expect(out.items[0]?.priceLabel).toContain('帖内报价范围');
  });
  it('filters wrong direction, ended status and non-London evidence, leaving expiry for strategy checks', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        response(
          searchBody([
            listing(),
            listing({ listingId: 'listing_b', tradeType: 'BUY' }),
            listing({ listingId: 'listing_c', status: 'SOLD' }),
            listing({ listingId: 'listing_d', availableUntil: '2020-01-01T00:00:00Z' }),
            listing({
              listingId: 'listing_e',
              title: 'Manchester 单间',
              description: '曼彻斯特出租',
              tags: ['租房'],
              timeZone: 'Europe/London',
            }),
          ]),
        ),
      ),
    );
    const out = await createMarketSearch({ logger, fetchImpl }).find({
      keyword: '小绿锅',
      page: 1,
      tradeType: 'SELL',
    });
    expect(out.items.map((l) => l.id)).toEqual(['listing_a', 'listing_d']);
  });
  it('allows BUY and ANY searches without treating every user as a buyer', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(response(searchBody([listing({ tradeType: 'BUY' })]))),
    );
    expect(
      (
        await createMarketSearch({ logger, fetchImpl }).find({
          keyword: '小绿锅',
          page: 1,
          tradeType: 'BUY',
        })
      ).items,
    ).toHaveLength(1);
    await createMarketSearch({ logger, fetchImpl }).find({
      keyword: '搭子',
      page: 1,
      tradeType: 'ANY',
    });
    const [input] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(new URL(input).searchParams.has('tradeType')).toBe(false);
  });
  it('does not call the network for a private keyword', async () => {
    const fetchImpl = vi.fn();
    await expect(
      createMarketSearch({ logger, fetchImpl }).find({
        keyword: '联系我 07700 900123',
        page: 1,
        tradeType: 'SELL',
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('validates envelopes and rejects responses rather than accepting an error as an empty successful search', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ code: 'ERROR', data: searchBody([]) }))),
    );
    await expect(
      createMarketSearch({ logger, fetchImpl }).find({
        keyword: '小绿锅',
        page: 1,
        tradeType: 'SELL',
      }),
    ).rejects.toThrow();
  });
  it('fetches the same public detail, preserves original publication date and keeps ended status visible for downstream rejection', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response(listing({ status: 'SOLD' }))));
    const detail = await createMarketSearch({ logger, fetchImpl }).detail('listing_a');
    expect(detail.status).toBe('SOLD');
    expect(detail.sourcePublishedAt).toBe('2026-09-01T00:00:00Z');
    const [input] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(input).toContain('/public/listings/listing_a');
  });
  it('rejects a detail response about another listing', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response(listing({ listingId: 'listing_b' }))));
    await expect(createMarketSearch({ logger, fetchImpl }).detail('listing_a')).rejects.toThrow();
  });
  it('never accepts a source link outside the supported domains', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        response(searchBody([listing({ sourceUrl: 'https://xiaohongshu.com.evil.example/foo' })])),
      ),
    );
    const out = await createMarketSearch({ logger, fetchImpl }).find({
      keyword: '小绿锅',
      page: 1,
      tradeType: 'SELL',
    });
    expect(out.items[0]?.sourceUrl).toBeNull();
  });
});

describe('market availability date contracts', () => {
  it('rejects an explicit ended-post marker even when the imported status still says ON_SALE', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        response(searchBody([listing({ description: '伦敦小绿锅\n已出\n#伦敦二手' })])),
      ),
    );
    expect(
      (
        await createMarketSearch({ logger, fetchImpl }).find({
          keyword: '小绿锅',
          page: 1,
          tradeType: 'SELL',
        })
      ).items,
    ).toEqual([]);
  });
  it('accepts public calendar dates and treats expiry day as inclusive in London', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        response(
          searchBody([listing({ availableFrom: '2026-01-01', availableUntil: '2099-01-01' })]),
        ),
      ),
    );
    const out = await createMarketSearch({ logger, fetchImpl }).find({
      keyword: '小绿锅',
      page: 1,
      tradeType: 'SELL',
    });
    expect(out.items[0]?.availableUntil).toBe('2099-01-01');
    const item = out.items[0]!;
    expect(
      isActiveMarketListing(
        { ...item, availableUntil: '2026-10-10' },
        new Date('2026-10-10T20:00:00Z'),
      ),
    ).toBe(true);
    expect(
      isActiveMarketListing(
        { ...item, availableUntil: '2026-10-10' },
        new Date('2026-10-10T23:30:00Z'),
      ),
    ).toBe(false);
  });
});
