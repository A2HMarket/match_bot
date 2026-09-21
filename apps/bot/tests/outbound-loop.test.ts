import { describe, expect, it, vi } from 'vitest';
import { drainOutbound } from '../src/outbound-loop.js';

describe('drainOutbound', () => {
  it('sends each pending row and marks sent/failed', async () => {
    const rows = [
      { id: 'a', target: '-1', text: 'x' },
      { id: 'b', target: '-1', text: 'y' },
    ];
    const outbound = {
      claimPending: vi.fn(() => Promise.resolve(rows)),
      markSent: vi.fn(() => Promise.resolve()),
      markFailed: vi.fn(() => Promise.resolve()),
    };
    const sender = {
      send: vi.fn((m: { id: string }) =>
        m.id === 'b' ? Promise.reject(new Error('kicked')) : Promise.resolve(),
      ),
    };
    await drainOutbound({
      repos: { outbound } as never,
      sender,
      logger: { error: vi.fn() } as never,
    });
    expect(outbound.markSent).toHaveBeenCalledWith('a');
    expect(outbound.markFailed).toHaveBeenCalledWith('b', expect.stringContaining('kicked'));
  });
});
