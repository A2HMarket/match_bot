import { describe, expect, it } from 'vitest';
import { londonToday } from '../src/agent.js';

describe('londonToday', () => {
  it('gives the weekday and ISO date in London time', () => {
    expect(londonToday(new Date('2026-09-23T12:00:00Z'))).toBe('Wednesday 2026-09-23');
  });
  it('rolls over at London midnight, not UTC midnight (BST)', () => {
    // 23:30 UTC on Saturday is already 00:30 Sunday in London during BST
    expect(londonToday(new Date('2026-09-26T23:30:00Z'))).toBe('Sunday 2026-09-27');
  });
  it('uses GMT in winter', () => {
    expect(londonToday(new Date('2026-12-05T23:30:00Z'))).toBe('Saturday 2026-12-05');
  });
});
