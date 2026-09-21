import { describe, expect, it } from 'vitest';
import { resolvePhase } from '../src/phase.js';

const group = (phase: number) => ({ phase }) as never;
describe('resolvePhase', () => {
  it.each([
    [group(2), 0, 2],
    [group(0), 2, 0],
    [null, 1, 1],
  ])('group %o default %i -> %i', (g, d, expected) => {
    expect(resolvePhase({ group: g, defaultPhase: d as 0 | 1 | 2 })).toBe(expected);
  });
});
