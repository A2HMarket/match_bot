import { describe, expect, it } from 'vitest';
import { decideOutbound } from '../src/outbound.js';
import { DEFAULT_THRESHOLDS as t } from '../src/thresholds.js';

const good = { worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0.01 };
describe('decideOutbound', () => {
  it.each([
    ['phase 0 always dry_run', { phase: 0, verdict: good, rateOk: true }, 'dry_run'],
    ['phase 0 dry_run even without verdict', { phase: 0, verdict: null, rateOk: false }, 'dry_run'],
    ['phase 1 always review', { phase: 1, verdict: good, rateOk: true }, 'review'],
    ['phase 2 auto when good and rate ok', { phase: 2, verdict: good, rateOk: true }, 'auto'],
    ['phase 2 review when rate exceeded', { phase: 2, verdict: good, rateOk: false }, 'review'],
    ['phase 2 review when jev unavailable', { phase: 2, verdict: null, rateOk: true }, 'review'],
    [
      'phase 2 review when language doubtful',
      { phase: 2, verdict: { ...good, languageOk: 0.5 }, rateOk: true },
      'review',
    ],
    [
      'phase 2 drop when not worth it',
      { phase: 2, verdict: { ...good, worthReplying: 0.8 }, rateOk: true },
      'drop',
    ],
    [
      'phase 2 drop when unverified supplier',
      { phase: 2, verdict: { ...good, mentionsUnverified: 0.9 }, rateOk: true },
      'drop',
    ],
  ])('%s', (_n, p, expected) => {
    expect(decideOutbound({ ...p, phase: p.phase as 0 | 1 | 2, t })).toBe(expected);
  });
});

describe('decideOutbound with onUnsure = drop (无人值守)', () => {
  const unattended = { t, onUnsure: 'drop' as const };
  it.each([
    ['jev unavailable', { verdict: null, rateOk: true }],
    ['rate exceeded', { verdict: good, rateOk: false }],
    ['language doubtful', { verdict: { ...good, languageOk: 0.5 }, rateOk: true }],
    [
      'worth replying in the middle band',
      { verdict: { ...good, worthReplying: 1.8 }, rateOk: true },
    ],
  ])('phase 2 does not send when unsure: %s', (_n, p) => {
    expect(decideOutbound({ ...p, phase: 2, ...unattended })).toBe('drop');
  });
  it('still sends confident drafts', () => {
    expect(decideOutbound({ phase: 2, verdict: good, rateOk: true, ...unattended })).toBe('auto');
  });
  it('does not change phase 1: a human-review phase is still reviewed', () => {
    expect(decideOutbound({ phase: 1, verdict: good, rateOk: true, ...unattended })).toBe('review');
  });
});
