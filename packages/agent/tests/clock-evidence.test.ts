import { describe, it, expect } from 'vitest';
import { removeSupportedClockClaims } from '../src/clock-evidence.js';
describe('clock evidence formatting', () => {
  it('recognizes source AM/PM and 24-hour equivalents without inventing minute zero', () => {
    expect(removeSupportedClockClaims('10:00–17:30', 'Open 10 am to 5:30 pm')).toBe('–');
    expect(removeSupportedClockClaims('00:00 / 12:00', '12am and 12pm')).toBe(' / ');
  });
  it('retains unsupported times and never mistakes PM for morning or a price for a clock', () => {
    expect(removeSupportedClockClaims('05:30–18:00', '5:30pm')).toBe('05:30–18:00');
    expect(removeSupportedClockClaims('17:30', '£17.30')).toBe('17:30');
    expect(removeSupportedClockClaims('10:30', 'Open 10am')).toBe('10:30');
  });
});
