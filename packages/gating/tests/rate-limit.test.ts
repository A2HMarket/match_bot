import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/rate-limit.js';

describe('createRateLimiter', () => {
  it('allows below limit, blocks at limit', async () => {
    const count = vi.fn(() => Promise.resolve(2));
    const rl = createRateLimiter({ countSentToTargetSince: count });
    expect(await rl.check({ target: '-1', limitPerDay: 3, now: new Date() })).toBe(true);
    count.mockResolvedValueOnce(3);
    expect(await rl.check({ target: '-1', limitPerDay: 3, now: new Date() })).toBe(false);
  });
  it('counts only recommendations, since UTC midnight', async () => {
    const count = vi.fn(() => Promise.resolve(0));
    const rl = createRateLimiter({ countSentToTargetSince: count });
    await rl.check({ target: '-1', limitPerDay: 3, now: new Date('2026-09-24T15:30:00Z') });
    expect(count).toHaveBeenCalledWith('-1', new Date('2026-09-24T00:00:00Z'), 'recommendation');
  });
});
