import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, canTransition, transition } from '../src/demand.js';

describe('demand status machine', () => {
  it('allows open -> clarifying', () => {
    expect(transition('open', 'clarifying')).toBe('clarifying');
  });
  it('closed is terminal', () => {
    expect(canTransition('closed', 'open')).toBe(false);
    expect(() => transition('closed', 'open')).toThrow(IllegalTransitionError);
  });
});
