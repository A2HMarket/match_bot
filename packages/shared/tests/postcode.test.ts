import { describe, expect, it } from 'vitest';
import { normalizePostcode } from '../src/postcode.js';

describe('normalizePostcode', () => {
  it('normalizes a full postcode', () => {
    expect(normalizePostcode('e14 9ab')).toEqual({ full: 'E149AB', outward: 'E14' });
  });
  it('accepts an outward code alone', () => {
    expect(normalizePostcode('SE1')).toEqual({ full: 'SE1', outward: 'SE1' });
  });
  it('rejects garbage', () => {
    expect(normalizePostcode('hello')).toBeNull();
  });
});
