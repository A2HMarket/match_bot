import { describe, expect, it } from 'vitest';
import { demandDraftSchema, outboundDraftSchema, supplyDraftSchema } from '../src/drafts.js';
import { isServiceCategory } from '../src/demand.js';

describe('demandDraftSchema', () => {
  it('accepts a minimal valid draft', () => {
    const d = demandDraftSchema.parse({ category: 'man_and_van', confidence: 0.9 });
    expect(d.category).toBe('man_and_van');
  });
  it('rejects confidence out of range', () => {
    expect(() => demandDraftSchema.parse({ category: 'man_and_van', confidence: 1.5 })).toThrow();
  });
  it('rejects non-integer budgetPence', () => {
    expect(() =>
      demandDraftSchema.parse({ category: 'man_and_van', confidence: 0.5, budgetPence: 12.5 }),
    ).toThrow();
  });
});

describe('supplyDraftSchema', () => {
  it('requires expiresAt as ISO datetime', () => {
    expect(() =>
      supplyDraftSchema.parse({ category: 'man_and_van', expiresAt: 'tomorrow' }),
    ).toThrow();
    expect(
      supplyDraftSchema.parse({ category: 'man_and_van', expiresAt: '2026-10-01T00:00:00Z' })
        .category,
    ).toBe('man_and_van');
  });
});

describe('outboundDraftSchema', () => {
  it('requires channel, target, text', () => {
    expect(() => outboundDraftSchema.parse({ channel: 'telegram', text: 'hi' })).toThrow();
    expect(
      outboundDraftSchema.parse({ channel: 'telegram', target: '-100123', text: 'hi' }).target,
    ).toBe('-100123');
  });
});

describe('isServiceCategory', () => {
  it('is true only for paid categories', () => {
    expect(isServiceCategory('man_and_van')).toBe(true);
    expect(isServiceCategory('housing')).toBe(false);
  });
});
