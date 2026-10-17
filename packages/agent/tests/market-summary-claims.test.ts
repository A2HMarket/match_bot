import { describe, expect, it } from 'vitest';
import { claimsCompleteMarketFit } from '../src/market-summary-claims.js';
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
