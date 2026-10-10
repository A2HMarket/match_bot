import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { MarketListing } from '@matchbot/websearch';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { marketSearchTool } from '../../src/tools/market-search.js';
import { marketEnrichTool } from '../../src/tools/market-enrich.js';
import { replyWithMarketResultsTool } from '../../src/tools/reply-with-market-results.js';
const POT: MarketListing = {
  id: 'listing_a',
  title: '伦敦 小绿锅',
  description: '小绿锅成色新，Camberwell 自提。',
  tags: ['物品交易'],
  tradeType: 'SELL',
  status: 'ON_SALE',
  url: 'https://a2hmarket.ai/listings/listing_a',
  sourceUrl: 'https://www.xiaohongshu.com/discovery/item/n1?xsec_token=tok',
  isRepost: true,
  priceLabel: '帖内报价范围：£5–£80（单品价格需确认）',
  availableFrom: null,
  availableUntil: null,
  sourcePublishedAt: '2026-09-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
};
const deps = () => ({
  env: { OUTBOUND_UNSURE_ACTION: 'review' },
  repos: {
    traces: { create: vi.fn(() => Promise.resolve({})) },
    outbound: {
      create: vi.fn((draft: unknown, status: string) =>
        Promise.resolve({ id: 'out', status, ...(draft as object) }),
      ),
      countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
    },
  },
  marketSearch: {
    find: vi.fn(() => Promise.resolve({ items: [POT], hasNext: true, total: 50 })),
    detail: vi.fn(() => Promise.resolve(POT)),
  },
  jev: { evaluate: vi.fn() },
  evaluateOutbound: vi.fn(() =>
    Promise.resolve({ ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }),
  ),
  thresholds: DEFAULT_THRESHOLDS,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  userId: 'u',
  chatId: '-1',
  groupId: 'g',
  phase: 0,
  sourceMessageId: 'm',
  source: { userId: '42', messageId: '77' },
  recentReplies: [],
  demand: { category: 'second_hand', confidence: 0.95, lang: 'zh' },
  ...over,
});
const rc = (c: MatchContext) => ({ context: c }) as never;
const query = (keyword: string, entity: string | null = null, page = 1) => ({
  keyword,
  page,
  tradeType: 'SELL',
  entity,
});
const search = (queries = [query('小绿锅')], purpose = 'discover', intent = 'second_hand') => ({
  queries,
  purpose,
  intent,
});
const args = {
  intro: '有闲平台这条有小绿锅，可以先看成色和自提位置：',
  recommendations: [
    {
      ref: 'm1',
      name: '小绿锅',
      group: '厨房小家电',
      summary: '成色新，可在 Camberwell 自提。',
      reason: '适合想自提的人。',
      evidence: '小绿锅成色新，Camberwell 自提',
      facts: [{ label: 'location', value: 'Camberwell', quote: 'Camberwell 自提' }],
    },
  ],
};

describe('market research tools', () => {
  it('executes the current user target direction even when the model requests the opposite side', async () => {
    const d = deps(),
      c = ctx({ marketTarget: 'SELL' });
    const out = JSON.parse(
      await marketSearchTool(d as never).invoke(
        rc(c),
        JSON.stringify(search([{ ...query('小绿锅'), tradeType: 'BUY' }])),
      ),
    ) as { effectiveTradeType: string };
    expect(d.marketSearch.find).toHaveBeenCalledWith(
      expect.objectContaining({ tradeType: 'SELL' }),
    );
    expect(out.effectiveTradeType).toBe('SELL');
  });
  it('batches synonyms, deduplicates listing IDs and keeps refs through public detail enrichment', async () => {
    const d = deps(),
      c = ctx();
    d.marketSearch.find
      .mockResolvedValueOnce({ items: [POT], hasNext: true, total: 50 })
      .mockResolvedValueOnce({
        items: [POT, { ...POT, id: 'listing_b', url: 'https://a2hmarket.ai/listings/listing_b' }],
        hasNext: false,
        total: 2,
      });
    const first = JSON.parse(
      await marketSearchTool(d as never).invoke(
        rc(c),
        JSON.stringify(search([query('小绿锅'), query('多功能电煮锅')])),
      ),
    ) as { listings: Array<{ ref: string }> };
    expect(first.listings.map((l) => l.ref)).toEqual(['m1', 'm2']);
    await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] }));
    expect(c.marketListings?.[0]?.ref).toBe('m1');
    expect(d.marketSearch.detail).toHaveBeenCalledWith('listing_a');
    await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] }));
    expect(d.marketSearch.detail).toHaveBeenCalledTimes(1);
  });
  it('caches empty and failed queries while permitting different keywords', async () => {
    const d = deps(),
      c = ctx(),
      t = marketSearchTool(d as never);
    d.marketSearch.find.mockRejectedValueOnce(new Error('network'));
    const first = JSON.parse(await t.invoke(rc(c), JSON.stringify(search()))) as {
      failures: unknown[];
    };
    expect(first.failures).toHaveLength(1);
    await t.invoke(rc(c), JSON.stringify(search()));
    await t.invoke(rc(c), JSON.stringify(search([query('电煮锅')])));
    expect(d.marketSearch.find).toHaveBeenCalledTimes(2);
  });
  it.each([{ outboundBlocked: true }, { xhsNotes: [] }, { searchResults: [] }])(
    'does not bypass a decline or switch sources: %j',
    async (over) => {
      const d = deps();
      await marketSearchTool(d as never).invoke(rc(ctx(over)), JSON.stringify(search()));
      expect(d.marketSearch.find).not.toHaveBeenCalled();
    },
  );
  it('enforces category, known entity and private-query prerequisites', async () => {
    const d = deps(),
      t = marketSearchTool(d as never);
    await t.invoke(
      rc(ctx({ demand: { category: 'job', confidence: 0.9 } })),
      JSON.stringify(search()),
    );
    await t.invoke(rc(ctx()), JSON.stringify(search([query('联系我 07700 900123')])));
    await t.invoke(rc(ctx()), JSON.stringify(search([query('未知物品', '未知物品')], 'enrich')));
    expect(d.marketSearch.find).not.toHaveBeenCalled();
  });
  it('limits discovery searches to four and total queries to eight', async () => {
    const d = deps(),
      c = ctx(),
      t = marketSearchTool(d as never);
    for (const keyword of ['小绿锅', '电煮锅', '电锅', '电火锅'])
      await t.invoke(rc(c), JSON.stringify(search([query(keyword)])));
    expect(await t.invoke(rc(c), JSON.stringify(search([query('锅具')])))).toContain(
      'discovery budget',
    );
    for (const keyword of ['小绿锅 成色', '小绿锅 自提', '小绿锅 清仓', '小绿锅 同城'])
      await t.invoke(rc(c), JSON.stringify(search([query(keyword, '小绿锅')], 'enrich')));
    expect(
      await t.invoke(rc(c), JSON.stringify(search([query('小绿锅 候选', '小绿锅')], 'enrich'))),
    ).toContain('budget exhausted');
    expect(d.marketSearch.find).toHaveBeenCalledTimes(8);
  });
  it('caps and interleaves recall so a broad first query cannot crowd out the other topic', async () => {
    const d = deps(),
      c = ctx();
    const listings = Array.from({ length: 20 }, (_, i) => ({ ...POT, id: `listing_a${i}` }));
    d.marketSearch.find
      .mockResolvedValueOnce({ items: listings, hasNext: true, total: 20 })
      .mockResolvedValueOnce({
        items: [{ ...POT, id: 'listing_other' }],
        hasNext: false,
        total: 1,
      });
    await marketSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify(search([query('小绿锅'), query('电煮锅')])),
    );
    expect(c.marketListings?.[1]?.id).toBe('listing_other');
    expect(c.marketListings).toHaveLength(11);
  });
});

describe('reply_with_market_results', () => {
  it('renders actual item, its own post price/date and marketplace plus repost links', async () => {
    const d = deps();
    await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }] })),
      JSON.stringify(args),
    );
    const [draft, status] = d.repos.outbound.create.mock.calls[0] as unknown as [
      { text: string },
      string,
    ];
    expect(status).toBe('dry_run');
    expect(draft.text).toContain('1. 小绿锅');
    expect(draft.text).toContain('帖内报价范围');
    expect(draft.text).toContain('原帖发布 2026-09-01');
    expect(draft.text).not.toContain('原帖发布 2026-10-01');
    expect(draft.text).toContain(POT.url);
    expect(draft.text).toContain(POT.sourceUrl);
    expect(draft.text).toContain('不经手交易');
    expect(draft.text).toContain('[A2H详情]');
    expect(draft.text).toContain('来自A2H公开帖子');
    expect(draft.text).not.toContain('有闲');
    expect(draft).toMatchObject({ mentionUserId: '42', replyToMessageId: '77' });
  });
  it('keeps different owners of the same named item as separate offers, without mixing their facts', async () => {
    const d = deps(),
      second = {
        ...POT,
        id: 'listing_b',
        url: 'https://a2hmarket.ai/listings/listing_b',
        priceLabel: '帖子未标价',
        ref: 'm2',
      };
    await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }, second] })),
      JSON.stringify({
        ...args,
        recommendations: [args.recommendations[0], { ...args.recommendations[0], ref: 'm2' }],
      }),
    );
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('2. 小绿锅');
    expect(draft.text).toContain('帖子未标价');
  });
  it.each([
    { ref: 'm9' },
    { name: '编造物品' },
    { evidence: '随意编了没写过的话' },
    { summary: '联系微信 abc123' },
    { summary: '小绿锅只要£5，符合预算' },
    { facts: [{ label: 'location', value: 'Stratford', quote: 'Camberwell 自提' }] },
  ])('rejects unknown refs, unsupported facts and public contact leakage: %j', async (patch) => {
    const d = deps();
    expect(
      await replyWithMarketResultsTool(d as never).invoke(
        rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }] })),
        JSON.stringify({ ...args, recommendations: [{ ...args.recommendations[0], ...patch }] }),
      ),
    ).toContain('invalid recommendation');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('reports all evidence, fact and price errors together rather than one repair per field', async () => {
    const d = deps();
    const out = await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }] })),
      JSON.stringify({
        ...args,
        recommendations: [
          {
            ...args.recommendations[0],
            evidence: '不存在的原文',
            summary: '单件1镑',
            facts: [{ label: 'date', value: '2026-09-01', quote: POT.description }],
          },
        ],
      }),
    );
    expect(out).toContain('recommendations.0.summary/reason/facts');
    expect(out).toContain('recommendations.0.evidence');
    expect(out).toContain('recommendations.0.facts.0.value');
    expect(out).toContain('sourcePublishedAt/createdAt');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('rejects an offer that became sold during enrichment', async () => {
    const d = deps(),
      c = ctx({ marketListings: [{ ...POT, ref: 'm1' }] });
    d.marketSearch.detail.mockResolvedValueOnce({ ...POT, status: 'SOLD' });
    await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] }));
    await replyWithMarketResultsTool(d as never).invoke(rc(c), JSON.stringify(args));
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it.each([
    [0, true, false, 'dry_run'],
    [1, true, true, 'pending'],
    [2, true, false, 'pending'],
    [2, false, true, 'pending'],
  ] as const)('retains phase %i approval semantics', async (phase, ok, approval, status) => {
    const d = deps();
    if (!ok)
      d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never);
    const c = ctx({ phase, marketListings: [{ ...POT, ref: 'm1' }] }),
      t = replyWithMarketResultsTool(d as never);
    expect(await t.needsApproval(rc(c), args, 'call')).toBe(approval);
    await t.invoke(rc(c), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), status);
  });
  it('does not send when Jev is unavailable and no one is reviewing', async () => {
    const d = { ...deps(), env: { OUTBOUND_UNSURE_ACTION: 'drop' } };
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never);
    await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ phase: 2, marketListings: [{ ...POT, ref: 'm1' }] })),
      JSON.stringify(args),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});
