import { describe, expect, it } from 'vitest';
import { scoreSuppliers } from '../src/score-suppliers.js';

const now = new Date('2026-09-25T10:00:00Z');
const sup = (over: Partial<Parameters<typeof scoreSuppliers>[0]['suppliers'][number]>) =>
  ({
    id: 's',
    category: 'man_and_van',
    name: 'S',
    serviceArea: ['LONDON'],
    languages: ['en'],
    pool: 'A',
    isSameDay: false,
    isWeekend: false,
    priceType: 'hourly',
    rating: null,
    lastVerifiedAt: now,
    ...over,
  }) as never;
const demand = { category: 'man_and_van' as const, confidence: 0.9, fromPostcode: 'E14', lang: 'ru', whenAt: '2026-09-27T09:00:00Z' };

describe('scoreSuppliers', () => {
  it('ranks area match + language + weekend above generic', () => {
    const r = scoreSuppliers({
      demand,
      suppliers: [sup({ id: 'generic' }), sup({ id: 'fit', serviceArea: ['E14', 'E1'], languages: ['en', 'ru'], isWeekend: true })],
      now,
    });
    expect(r[0]!.id).toBe('fit');
    expect(r[0]!.reasons).toEqual(expect.arrayContaining([expect.stringContaining('E14'), expect.stringContaining('ru'), expect.stringContaining('weekend')]));
  });
  it('caps B pool at 0.6', () => {
    const r = scoreSuppliers({ demand, suppliers: [sup({ id: 'b', pool: 'B', serviceArea: ['E14'], languages: ['ru'], isWeekend: true })], now });
    expect(r[0]!.score).toBeLessThanOrEqual(0.6);
  });
  it('excludes suppliers outside service area', () => {
    const r = scoreSuppliers({ demand, suppliers: [sup({ id: 'far', serviceArea: ['SW19'] })], now });
    expect(r).toEqual([]);
  });
  it('penalises stale verification', () => {
    const fresh = scoreSuppliers({ demand, suppliers: [sup({ id: 'a' })], now })[0]!.score;
    const stale = scoreSuppliers({ demand, suppliers: [sup({ id: 'a', lastVerifiedAt: new Date('2026-01-01') })], now })[0]!.score;
    expect(stale).toBeLessThan(fresh);
  });
});
