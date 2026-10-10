import { describe, expect, it } from 'vitest';
import { isStandaloneMarketAdvertisement, selectMarketTradeType } from '../src/market-request.js';
describe('isStandaloneMarketAdvertisement', () => {
  it.each([
    'Selling an IKEA MALM desk, £25, collection from Stratford',
    '出一辆自行车，50镑自提',
    '房间出租，包账单',
    'Продам детскую коляску',
    'Vendo sofá, £60',
  ])('identifies pure ads: %s', (text) => {
    expect(isStandaloneMarketAdvertisement(text)).toBe(true);
  });
  it.each([
    'Anyone want to buy my old iPhone?',
    '出售餐桌，帮我找个买家？',
    '找伦敦房源',
    'Room available, can you help me find a tenant?',
    '伦敦周末搭子',
    'Продам коляску, кто хочет купить?',
  ])('keeps explicit requests: %s', (text) => {
    expect(isStandaloneMarketAdvertisement(text)).toBe(false);
  });
});

describe('selectMarketTradeType', () => {
  it.each([
    '伦敦收小绿锅',
    '找Stratford房源',
    '求中国到伦敦帮带书',
    'Can anyone bring my books from London to Beijing?',
  ])('seeker finds offers: %s', (text) => expect(selectMarketTradeType(text)).toBe('SELL'));
  it.each([
    '我想卖掉餐桌，看看谁在收',
    '我是房东，帮我找租客',
    '我可以帮带，想看看谁需要',
    'I can bring books, anyone need help?',
    'Anyone want to buy my old phone?',
  ])('provider finds requests: %s', (text) => expect(selectMarketTradeType(text)).toBe('BUY'));
  it.each(['找网球搭子', '想找一起看展的人', 'Looking for a tennis partner'])(
    'companions search PEER posts: %s',
    (text) => expect(selectMarketTradeType(text)).toBe('PEER'),
  );
});
