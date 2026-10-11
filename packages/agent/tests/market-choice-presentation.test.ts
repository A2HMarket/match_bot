import { describe, expect, it } from 'vitest';
import { renderMarketChoiceReply } from '../src/market-choice-presentation.js';
import type { MarketCandidate } from '../src/market-research.js';
describe('market choice practical details', () => {
  it('shows the room term and layout from its own source without converting that to confirmed move-in', () => {
    const listing: MarketCandidate = {
      id: 'listing_a',
      ref: 'm1',
      title: '伦敦E14单间',
      description:
        '转租：E14单间\n时间：9月29日起可入住，租期至2027年9月9日\n户型：3人合租，与1人共用卫生间\n地点：E14\n- 单间｜£1100/月',
      tags: [],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '帖子未标价',
      sourcePublishedAt: null,
      createdAt: null,
      availableFrom: null,
      availableUntil: null,
    };
    const { text, choices } = renderMarketChoiceReply({
      listings: [listing],
      selections: [{ ref: 'm1', name: '单间', evidence: '转租：E14单间' }],
      zh: true,
      plan: {
        intent: 'housing',
        needs: [{ id: 'room', terms: ['单间'] }],
        preferences: ['11月初入住'],
        essentialPreferences: ['11月初入住'],
        budget: 1200,
        requiredArea: ['E14'],
      },
    });
    expect(text).toContain('9月29日起可入住，租期至2027年9月9日');
    expect(text).toContain('3人合租，与1人共用卫生间');
    expect(text).toContain('待确认：11月初入住');
    expect(choices.primary).toHaveLength(0);
  });
});
