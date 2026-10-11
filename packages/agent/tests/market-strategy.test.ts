import { describe, it, expect } from 'vitest';
import type { MarketListing } from '@matchbot/websearch';
import { assessMarketListing, rankMarketListings, toMarketPlan } from '../src/market-strategy.js';
import type { MarketPlan } from '../src/market-strategy.js';
const listing = (description: string, id = 'a'): MarketListing => ({
  id,
  title: '伦敦出闲置',
  description,
  tags: [],
  tradeType: 'SELL',
  status: 'ON_SALE',
  url: `https://a2hmarket.ai/listings/${id}`,
  sourceUrl: null,
  isRepost: false,
  priceLabel: '帖子未标价',
  availableFrom: null,
  availableUntil: null,
  sourcePublishedAt: null,
  createdAt: null,
});
const plan: MarketPlan = {
  intent: 'second_hand',
  needs: [{ id: 'desk', terms: ['书桌'] }],
  preferences: [],
  budget: 50,
  requiredArea: ['E14'],
};
describe('source-grounded market strategy', () => {
  it('keeps route words out of the core rather than requiring a literal full query', () => {
    const p = toMarketPlan({
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带 上海 伦敦', '上海 飞 伦敦 帮带'] }],
      preferences: [],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: [],
      budget: null,
      route: { from: ['上海'], to: ['伦敦'] },
      dateRange: null,
    });
    expect(p.needs[0]?.terms).toEqual(['帮带']);
    expect(
      assessMarketListing(listing('帮带：11月4日从上海飞往英国\n路线：上海 -> 伦敦'), p).needs,
    ).toEqual(['carry']);
  });
  it('does not invent exclusions or promote explicit preferences into hard constraints', () => {
    const p = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'printer', terms: ['打印机'] }],
        preferences: [],
        requiredTerms: ['无线'],
        excludeTerms: ['墨盒', '回收'],
        requiredArea: [],
        budget: 60,
        route: null,
        dateRange: null,
      },
      '收打印机，预算60镑，最好无线',
    );
    expect(p.excludeTerms).toEqual([]);
    expect(p.requiredTerms).toEqual([]);
    expect(p.preferences).toContain('无线');
  });
  it('retains an explicit carry month even when the model omits dateRange', () => {
    const p = toMarketPlan(
      {
        intent: 'carry',
        needs: [{ id: 'carry', terms: ['帮带'] }],
        preferences: [],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: [],
        budget: null,
        route: { from: ['上海'], to: ['伦敦'] },
        dateRange: null,
      },
      '找2026年11月上海飞伦敦帮带',
    );
    expect(p.dateRange).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(
      assessMarketListing(listing('时间：10月27日\n帮带：10月27日上海飞伦敦，11月9日回上海'), p)
        .checks,
    ).toContainEqual(expect.objectContaining({ label: 'date', status: 'mismatch' }));
  });
  it('does not interpret fee decimals or enumerated route legs as a matching future trip', () => {
    const row = assessMarketListing(
      listing(
        '时间：10月23日\n去程：10月12日晚伦敦飞，13日晚抵上海；回程：10月23日早北京飞，23日晚抵伦敦\n- 帮带｜0.2-0.5kg: 100rmb｜提供伦敦至上海、北京至伦敦的往返行李额帮带服务',
      ),
      {
        intent: 'carry',
        needs: [{ id: 'carry', terms: ['帮带'] }],
        preferences: [],
        route: { from: ['上海'], to: ['伦敦'] },
        dateRange: { from: '2026-11-01', to: '2026-11-30' },
      },
    );
    expect(row.checks).toContainEqual(
      expect.objectContaining({ label: 'date', status: 'mismatch' }),
    );
    expect(row.checks).not.toContainEqual(
      expect.objectContaining({ label: 'route', status: 'met' }),
    );
  });
  it('keeps beginner skill out of core needs and ignores imported hobby-as-invitation summaries', () => {
    const p = toMarketPlan(
      {
        intent: 'companion',
        needs: [
          { id: 'sport', terms: ['羽毛球'] },
          { id: 'skill', terms: ['初学者', '新手', 'beginner'] },
        ],
        preferences: ['周末'],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: [],
        budget: null,
        route: null,
        dateRange: null,
      },
      '伦敦周末找羽毛球搭子，初学者',
    );
    expect(p.needs).toHaveLength(1);
    expect(p.preferences).toContain('初学者');
    const n = {
      ...listing(
        '活动：逛公园、打羽毛球\n——原帖原文——\n找朋友一起逛公园。\n爱好是打羽毛球和看电视剧，羽毛球是新手水平。',
      ),
      title: '伦敦找朋友一起逛公园',
      tradeType: 'PEER' as const,
    };
    expect(assessMarketListing(n, p).needs).toEqual([]);
  });
  it('does not recommend explicitly non-beginner sessions to a beginner', () => {
    const row = assessMarketListing(
      {
        ...listing(
          '活动：伦敦羽毛球搭子\n——原帖原文——\n周六一起打羽毛球。\n非新手局，有一定基础再来～',
        ),
        tradeType: 'PEER',
      },
      {
        intent: 'companion',
        needs: [{ id: 'badminton', terms: ['羽毛球'] }],
        preferences: ['初学者'],
      },
    );
    expect(row.checks).toContainEqual(
      expect.objectContaining({ label: 'skill', status: 'mismatch' }),
    );
  });
  it('compares a buyer request against the seller price in the correct direction', () => {
    const buyer = { ...listing('- 书桌｜£100'), tradeType: 'BUY' as const };
    expect(assessMarketListing(buyer, plan).checks.find((c) => c.label === 'budget')?.status).toBe(
      'met',
    );
    expect(
      assessMarketListing({ ...buyer, description: '- 书桌｜£20' }, plan).checks.find(
        (c) => c.label === 'budget',
      )?.status,
    ).toBe('mismatch');
  });
  it('does not mistake per-weight carry fees for the user total budget', () => {
    const row = assessMarketListing(listing('帮带：伦敦上海\n- 帮带｜£10/kg'), {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      budget: 30,
    });
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('unknown');
  });
  it('does not borrow the chair price to satisfy a desk budget', () => {
    const row = assessMarketListing(
      listing('出售：书桌、椅子\n地点：E14\n- 书桌｜£120\n- 椅子｜£10'),
      plan,
    );
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('mismatch');
    expect(row.itemPriceEvidence).toBe('- 书桌｜£120');
  });
  it('finds an affordable sibling item but binds the final quote to the selected name', () => {
    const n = listing('出售：书桌\n地点：E14\n- 大书桌｜£120\n- 小书桌｜£30');
    expect(assessMarketListing(n, plan).checks.find((c) => c.label === 'budget')?.status).toBe(
      'met',
    );
    expect(
      assessMarketListing(n, plan, '大书桌').checks.find((c) => c.label === 'budget')?.status,
    ).toBe('mismatch');
    expect(assessMarketListing(n, plan, '小书桌').itemPriceEvidence).toBe('- 小书桌｜£30');
  });
  it('preserves unknown item prices instead of assigning a post price range', () => {
    const row = assessMarketListing(
      listing('出售：书桌、椅子等多件闲置，£1–£20\n- 书桌\n- 椅子｜£10'),
      plan,
    );
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('unknown');
  });
  it('does not call an unnormalized neighborhood a definite postcode conflict', () => {
    const row = assessMarketListing(listing('出租：大房间\n地点：狗岛 (Isle of Dogs)'), {
      ...plan,
      intent: 'housing',
      needs: [{ id: 'room', terms: ['房间'] }],
    });
    expect(row.checks.find((c) => c.label === 'area')?.status).toBe('unknown');
    const wrong = assessMarketListing(listing('出售：书桌\n地点：E20 Stratford'), plan);
    expect(wrong.checks.find((c) => c.label === 'area')?.status).toBe('mismatch');
  });
  it('matches the upper endpoint of a same-item price range', () => {
    const row = assessMarketListing(listing('- 书桌｜£40–80'), plan);
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('unknown');
  });
  it('covers both alternatives before filling the result slots', () => {
    const p = {
      ...plan,
      budget: undefined,
      requiredArea: [],
      needs: [
        { id: 'desk', terms: ['书桌'] },
        { id: 'chair', terms: ['办公椅'] },
      ],
    };
    const out = rankMarketListings(
      [listing('- 书桌', 'a'), listing('- 书桌', 'b'), listing('- 办公椅', 'c')],
      p as MarketPlan,
      2,
    );
    expect(out.map((r) => r.listing.id)).toEqual(['a', 'c']);
  });
  it('does not treat furnished rental descriptions as second-hand item offers', () => {
    expect(
      assessMarketListing(listing('出租：E14公寓，带书桌和办公椅\n- 公寓｜£2000'), plan).needs,
    ).toEqual([]);
  });
  it('keeps sold items out even when the bundle is still ON_SALE', () => {
    const row = assessMarketListing(
      listing('出售：书桌、椅子\n- 书桌｜£20｜❌已出\n- 椅子｜£10'),
      plan,
    );
    expect(row.checks.find((c) => c.label === 'availability')?.status).toBe('mismatch');
  });
  it('leaves undocumented preferences unconfirmed rather than claiming they are met', () => {
    const row = assessMarketListing(listing('出售：书桌\n- 书桌｜£30'), {
      ...plan,
      preferences: ['白色'],
    });
    expect(row.checks.find((c) => c.label === 'preference:白色')?.status).toBe('unknown');
  });
  it('does not use hobbies in a profile as a badminton invitation', () => {
    const p = {
      intent: 'companion',
      needs: [{ id: 'sport', terms: ['羽毛球'] }],
      preferences: [],
    } as const;
    const row = assessMarketListing(
      listing('找搭子：长期coffee chat\n个人背景：平时喜欢羽毛球'),
      p as unknown as MarketPlan,
    );
    expect(row.needs).toEqual([]);
  });
  it('binds the date to the offered route rather than a return trip', () => {
    const p: MarketPlan = {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      route: { from: ['上海'], to: ['伦敦'] },
      dateRange: { from: '2026-11-01', to: '2026-11-30' },
    };
    const row = assessMarketListing(
      listing('帮带：10月27日上海飞伦敦，11月9日回上海\n时间：去程10/27，回程11/9'),
      p,
    );
    expect(row.checks.find((c) => c.label === 'date')?.status).toBe('mismatch');
  });
  it('rejects a known wrong month and preserves a future return leg despite conflicting metadata', () => {
    const p: MarketPlan = {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      route: { from: ['上海'], to: ['伦敦'] },
      dateRange: { from: '2026-11-01', to: '2026-11-30' },
    };
    const stale = assessMarketListing(
      { ...listing('帮带：10月初上海飞伦敦\n时间：10月初'), availableUntil: '2026-10-31' },
      p,
    );
    expect(stale.checks.find((c) => c.label === 'date')?.status).toBe('mismatch');
    const future = assessMarketListing(
      {
        ...listing('帮带：上海到伦敦\n时间：10月17日\n- 往返帮带｜10.17✈️上海 11.1✈️伦敦'),
        availableUntil: '2026-10-17',
      },
      p,
    );
    expect(future.checks.find((c) => c.label === 'date')?.status).toBe('unknown');
    expect(future.checks.find((c) => c.label === 'date_conflict')?.status).toBe('unknown');
  });
  it('does not discard a clear future return leg because the imported expiry refers to a past outward leg', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    const year = future.getUTCFullYear();
    const n = {
      ...listing(
        `帮带：${year}年11月4日上海飞伦敦\n时间：${year - 2}年10月1日去程，${year}年11月4日返程`,
      ),
      availableUntil: '2020-01-01',
    };
    const row = assessMarketListing(n, {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
    });
    expect(row.checks.find((c) => c.label === 'availability')?.status).toBe('unknown');
    expect(
      assessMarketListing({ ...n, description: '- 书桌｜£20' }, plan).checks.find(
        (c) => c.label === 'availability',
      )?.status,
    ).toBe('mismatch');
  });
  it('rejects the reverse route and never silently supplies a missing year', () => {
    const p: MarketPlan = {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      route: { from: ['伦敦'], to: ['上海'] },
      dateRange: { from: '2026-10-20', to: '2026-10-31' },
    };
    expect(
      assessMarketListing(listing('帮带：10月25日上海飛伦敦\n路线：上海 -> 伦敦'), p).checks.find(
        (c) => c.label === 'route',
      )?.status,
    ).toBe('mismatch');
    const good = assessMarketListing(listing('帮带：10月21日伦敦飞上海'), p);
    expect(good.checks.find((c) => c.label === 'route')?.status).toBe('met');
    expect(good.checks.find((c) => c.label === 'date')?.status).toBe('unknown');
  });
});
