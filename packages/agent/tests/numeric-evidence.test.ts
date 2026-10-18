import { describe, expect, it } from 'vitest';
import { unsupportedNumericClaims } from '../src/numeric-evidence.js';

describe('numeric evidence across user-facing representations', () => {
  it('recognizes a month from a valid ISO task date without inventing another month', () => {
    expect(unsupportedNumericClaims('11月5日', '2026-11-05')).toEqual([]);
    expect(unsupportedNumericClaims('12月5日', '2026-11-05')).toEqual(['month:12']);
  });

  it('recognizes thousands separators without accepting a different amount', () => {
    expect(unsupportedNumericClaims('预算 £1,600', '预算 £1600')).toEqual([]);
    expect(unsupportedNumericClaims('预算 £1,650', '预算 £1600')).toEqual(['1650']);
  });
  it('recognizes equivalent clocks and month names', () => {
    expect(
      unsupportedNumericClaims(
        '10:00–18:00，周五21:00；12月24–26日关闭',
        '10am–6pm, Fridays 9pm. Closed 24–26 December.',
      ),
    ).toEqual([]);
    expect(unsupportedNumericClaims('17:45', '5.45pm')).toEqual([]);
  });
  it('does not use unrelated numbers or a different clock to prove a time', () => {
    expect(unsupportedNumericClaims('21:00', '21 tickets, price 00')).toEqual(['time:21:00']);
    expect(unsupportedNumericClaims('09:00', '9pm')).toEqual(['time:09:00']);
    expect(unsupportedNumericClaims('12月', '12 tickets')).toEqual(['month:12']);
  });
  it('preserves decimal prices and ignores list numbering and platform names', () => {
    expect(unsupportedNumericClaims('1. A2H £8.50\n2. £40', '£8.5 and £40')).toEqual([]);
    expect(unsupportedNumericClaims('£8.60', '£8.50')).toEqual(['8.6']);
  });
});
