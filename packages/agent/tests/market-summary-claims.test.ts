import { describe, expect, it } from 'vitest';
import {
  claimsCompleteMarketFit,
  claimsUnverifiedTravelFit,
} from '../src/market-summary-claims.js';
describe('whole-fit language', () => {
  it.each([
    '这套符合你的硬条件，但账单还不清楚。',
    '完全匹配，价格还需要确认。',
    'This fully meets your requirements.',
    'These meet your preference and it meets all your requirements.',
  ])('detects the unsupported blanket claim: %s', (text) =>
    expect(claimsCompleteMarketFit(text)).toBe(true),
  );
  it.each([
    '现在还不能说符合你的硬条件。',
    '是否完全符合还需要确认。',
    '地点符合你的要求，账单还未知。',
    '房租符合预算。',
    'It does not fully match your requirements.',
  ])('preserves scoped or explicitly unconfirmed judgement: %s', (text) =>
    expect(claimsCompleteMarketFit(text)).toBe(false),
  );
});
describe('unverified journey reassurance', () => {
  it.each([
    '同区自提，半小时内应该没问题，但具体地址没写。',
    '单程半小时内大概率没问题。',
    '同区自提，半小时单程大概率够，但具体门牌没写。',
    '半小时单程应该够。',
    '这条30分钟内能到。',
    'You should be able to get there within 30 minutes.',
  ])('rejects %s', (text) => expect(claimsUnverifiedTravelFit(text)).toBe(true));
  it.each([
    '建议你先问清具体位置，确认半小时内能到再去。',
    '半小时内能否到，现在还不知道。',
    '具体地址没写，30分钟内能到还不能确认。',
    '我不能保证半小时内能到，得先知道地址。',
    'Check whether you can get there within 30 minutes.',
  ])('preserves a check rather than a promise: %s', (text) =>
    expect(claimsUnverifiedTravelFit(text)).toBe(false),
  );
});
