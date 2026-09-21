import { describe, expect, it, vi } from 'vitest';
import { drainOutbound } from '../src/outbound-loop.js';

describe('drainOutbound', () => {
  it('sends each pending row and marks sent/failed', async () => {
    const rows = [
      { id: 'a', target: '-1', text: 'x' },
      { id: 'b', target: '-1', text: 'y' },
    ];
    const outbound = {
      claimPending: vi.fn(async () => rows),
      markSent: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    const sender = {
      send: vi.fn(async (m: { id: string }) => {
        if (m.id === 'b') throw new Error('kicked');
      }),
    };
    await drainOutbound({
      repos: { outbound } as never,
      sender: sender as never,
      logger: { error: vi.fn() } as never,
    });
    expect(outbound.markSent).toHaveBeenCalledWith('a');
    expect(outbound.markFailed).toHaveBeenCalledWith('b', expect.stringContaining('kicked'));
  });
});
