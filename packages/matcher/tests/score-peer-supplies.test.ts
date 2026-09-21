import { describe, expect, it } from 'vitest';
import { scorePeerSupplies } from '../src/score-peer-supplies.js';

const now = new Date('2026-09-25T10:00:00Z');
const supply = (over: Record<string, unknown>) =>
  ({
    id: 'p',
    category: 'man_and_van',
    area: 'E14',
    availability: 'Sunday',
    expiresAt: new Date('2026-09-30'),
    createdAt: now,
    userId: 'u',
    ...over,
  }) as never;
const demand = {
  category: 'man_and_van' as const,
  confidence: 0.9,
  fromPostcode: 'E14',
  whenText: 'Sunday',
};

describe('scorePeerSupplies', () => {
  it('prefers same area and overlapping availability text', () => {
    const r = scorePeerSupplies({
      demand,
      supplies: [supply({ id: 'far', area: 'SW19' }), supply({ id: 'near' })],
      now,
    });
    expect(r[0]!.id).toBe('near');
    expect(r[0]!.reasons).toContain('same area E14');
  });
  it('drops expired and other categories', () => {
    const r = scorePeerSupplies({
      demand,
      supplies: [
        supply({ id: 'x', expiresAt: new Date('2026-09-01') }),
        supply({ id: 'y', category: 'eot_cleaning' }),
      ],
      now,
    });
    expect(r).toEqual([]);
  });
});
