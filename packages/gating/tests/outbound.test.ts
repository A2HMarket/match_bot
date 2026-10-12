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
    // 2026-10-10 起没有中间带：过了硬下限就发，分数居中不再送审
    [
      'phase 2 auto when worth replying is middling',
      { phase: 2, verdict: { ...good, worthReplying: 1.8 }, rateOk: true },
      'auto',
    ],
    [
      'phase 2 auto even when language is doubtful',
      { phase: 2, verdict: { ...good, languageOk: 0.5 }, rateOk: true },
      'auto',
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
  ])('phase 2 does not send when unsure: %s', (_n, p) => {
    expect(decideOutbound({ ...p, phase: 2, ...unattended })).toBe('drop');
  });
  it('still sends middling drafts: only the hard floors gate sending', () => {
    const middling = { worthReplying: 1.27, languageOk: 0.6, mentionsUnverified: 0.03 };
    expect(decideOutbound({ phase: 2, verdict: middling, rateOk: true, ...unattended })).toBe(
      'auto',
    );
  });
  it('does not change phase 1: a human-review phase is still reviewed', () => {
    expect(decideOutbound({ phase: 1, verdict: good, rateOk: true, ...unattended })).toBe('review');
  });
});

describe('verified request status', () => {
  it('can acknowledge a request even when recommendation scores are low', () => {
    expect(
      decideOutbound({
        phase: 2,
        verdict: { ...good, worthReplying: 0.1, mentionsUnverified: 0.9 },
        rateOk: true,
        t,
        isVerifiedRequestStatus: true,
      }),
    ).toBe('auto');
    expect(
      decideOutbound({
        phase: 2,
        verdict: { ...good, worthReplying: 0.1, mentionsUnverified: 0.9 },
        rateOk: true,
        t,
      }),
    ).toBe('drop');
  });
  it.each([0, 1, 2] as const)(
    'retains phase %i and never auto-sends if Jev is unavailable',
    (phase) => {
      expect(
        decideOutbound({
          phase,
          verdict: null,
          rateOk: true,
          t,
          onUnsure: 'drop',
          isVerifiedRequestStatus: true,
        }),
      ).toBe(phase === 0 ? 'dry_run' : phase === 1 ? 'review' : 'drop');
    },
  );
  it('does not bypass a rate refusal', () => {
    expect(
      decideOutbound({
        phase: 2,
        verdict: good,
        rateOk: false,
        t,
        onUnsure: 'drop',
        isVerifiedRequestStatus: true,
      }),
    ).toBe('drop');
  });
});
