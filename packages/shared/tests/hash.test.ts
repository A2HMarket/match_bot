import { describe, expect, it } from 'vitest';
import { hashText } from '../src/hash.js';

describe('hashText', () => {
  it('returns sha256 hex', () => {
    expect(hashText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('is stable across calls', () => {
    expect(hashText('x')).toBe(hashText('x'));
  });
});
