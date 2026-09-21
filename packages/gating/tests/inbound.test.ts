import { describe, expect, it } from 'vitest';
import { decideInbound } from '../src/inbound.js';
import { DEFAULT_THRESHOLDS as T } from '../src/thresholds.js';

const base = {
  isDemand: 0,
  isSupply: 0,
  category: 'other' as const,
  isSensitive: 0,
  isMoveEvent: 0,
};
describe('decideInbound', () => {
  it.each([
    [
      'sensitive wins',
      { ...base, isDemand: 0.99, category: 'man_and_van' as const, isSensitive: 0.9 },
      { action: 'drop', reason: 'sensitive' },
    ],
    [
      'service demand enters',
      { ...base, isDemand: 0.8, category: 'man_and_van' as const },
      { action: 'enter_agent', category: 'man_and_van', kind: 'demand' },
    ],
    [
      'service supply enters',
      // 实测（pnpm eval, n=50）真实供给消息落在 0.96–0.98。
      { ...base, isSupply: 0.96, category: 'man_and_van' as const },
      { action: 'enter_agent', category: 'man_and_van', kind: 'supply' },
    ],
    [
      // 回归：同一轮评测里 is_supply 的金标负类最高到 0.77（俄语求职消息）。
      // 阈值 0.8 必须把它挡在门外，而不是依赖后面 isServiceCategory 的品类兜底。
      'highest observed non-supply score stays out',
      { ...base, isSupply: 0.77, category: 'man_and_van' as const },
      { action: 'drop', reason: 'not_demand' },
    ],
    [
      'both',
      { ...base, isDemand: 0.8, isSupply: 0.8, category: 'eot_cleaning' as const },
      { action: 'enter_agent', category: 'eot_cleaning', kind: 'both' },
    ],
    [
      'housing with move event tags',
      { ...base, isDemand: 0.9, category: 'housing' as const, isMoveEvent: 0.7 },
      { action: 'tag_move_event' },
    ],
    [
      'housing without move event drops',
      { ...base, isDemand: 0.9, category: 'housing' as const, isMoveEvent: 0.1 },
      { action: 'drop', reason: 'not_demand' },
    ],
    [
      'low confidence drops',
      { ...base, isDemand: 0.4, category: 'man_and_van' as const },
      { action: 'drop', reason: 'not_demand' },
    ],
  ])('%s', (_n, v, expected) => {
    expect(decideInbound(v, T)).toEqual(expected);
  });
});
