import { describe, expect, it } from 'vitest';
import { hasGuaranteedPurchaseClaim } from '../src/source-operation-claims.js';

describe('purchase access claims', () => {
  it.each(['走过去就能买到药', '这家肯定有货', 'You can go there and buy it'])(
    'rejects arrival guarantees: %s',
    (text) => expect(hasGuaranteedPurchaseClaim(text)).toBe(true),
  );
  it.each([
    '不能保证走过去就能买到',
    '这个目录不保证有货。',
    '不能保证一定有货',
    '官网列了营业时间，库存仍需确认。',
    '你是急用还是出门不方便？',
    '是否有货请先问门店',
  ])('keeps uncertainty and practical questions: %s', (text) =>
    expect(hasGuaranteedPurchaseClaim(text)).toBe(false),
  );
});
