import { describe, expect, it, vi } from 'vitest';
import { closeDemandTool } from '../../src/tools/close-demand.js';
import { doNothingTool } from '../../src/tools/do-nothing.js';
import { upsertSupplyTool } from '../../src/tools/upsert-supply.js';

describe('upsert_supply', () => {
  it('creates a supply in the group pool', async () => {
    const repos = {
      supplies: { create: vi.fn((p: unknown) => Promise.resolve({ id: 's1', ...(p as object) })) },
    };
    const rc = { context: { userId: 'u', groupId: 'g', sourceMessageId: 'm1' } } as never;
    const out = await upsertSupplyTool({ repos } as never).invoke(
      rc,
      JSON.stringify({
        category: 'man_and_van',
        availability: 'Sunday',
        area: 'E14',
        expiresAt: new Date(Date.now() + 14 * 86400e3).toISOString(),
      }),
    );
    expect(out).toContain('supply recorded');
    expect(repos.supplies.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u', groupId: 'g', sourceMessageId: 'm1' }),
    );
  });

  it('refuses outside group messages', async () => {
    const repos = { supplies: { create: vi.fn() } };
    const rc = { context: { userId: 'u', groupId: null, sourceMessageId: 'm1' } } as never;
    const out = await upsertSupplyTool({ repos } as never).invoke(
      rc,
      JSON.stringify({
        category: 'man_and_van',
        availability: null,
        area: null,
        expiresAt: new Date().toISOString(),
      }),
    );
    expect(out).toContain('group');
    expect(repos.supplies.create).not.toHaveBeenCalled();
  });
});

describe('close_demand', () => {
  it('closes the current demand', async () => {
    const repos = { demands: { setStatus: vi.fn(() => Promise.resolve({})) } };
    const rc = { context: { userId: 'u', demandId: 'd1' } } as never;
    await closeDemandTool({ repos } as never).invoke(rc, '{}');
    expect(repos.demands.setStatus).toHaveBeenCalledWith('d1', 'closed');
  });
});

describe('do_nothing', () => {
  it('writes a gate trace with the reason and returns ok', async () => {
    const repos = { traces: { create: vi.fn(() => Promise.resolve({})) } };
    const rc = { context: { userId: 'u', sourceMessageId: 'm1', phase: 0 } } as never;
    const out = await doNothingTool({ repos } as never).invoke(
      rc,
      JSON.stringify({ reason: 'chit-chat' }),
    );
    expect(out).toBe('ok');
    expect(repos.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'gate', inputRef: 'm1' }),
    );
  });
});
