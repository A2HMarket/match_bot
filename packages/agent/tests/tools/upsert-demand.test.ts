import { describe, expect, it, vi } from 'vitest';
import { upsertDemandTool } from '../../src/tools/upsert-demand.js';

function makeDeps() {
  return {
    demands: {
      findOpenByUser: vi.fn(() => Promise.resolve([] as Array<{ id: string; category: string }>)),
      create: vi.fn((p: unknown) => Promise.resolve({ id: 'd1', ...(p as object) })),
      update: vi.fn((id: string, p: unknown) => Promise.resolve({ id, ...(p as object) })),
    },
  };
}
const rc = { context: { userId: 'u', sourceMessageId: 'm1' } } as never;

const baseArgs = {
  category: 'man_and_van',
  whenText: null,
  whenAt: null,
  fromPostcode: null,
  toPostcode: null,
  quantity: null,
  budgetPence: null,
  lang: null,
  confidence: 0.9,
};

describe('upsert_demand', () => {
  it('creates when no open demand of that category, with normalized postcode', async () => {
    const repos = makeDeps();
    const t = upsertDemandTool({ repos } as never);
    const out = await t.invoke(
      rc,
      JSON.stringify({
        ...baseArgs,
        whenText: 'this Sunday',
        fromPostcode: 'e14 9ab',
        quantity: '8 boxes',
        lang: 'en',
      }),
    );
    expect(out).toContain('created');
    expect(repos.demands.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u', fromPostcode: 'E149AB', sourceMessageId: 'm1' }),
    );
  });

  it('updates the existing open demand of the same category', async () => {
    const repos = makeDeps();
    repos.demands.findOpenByUser.mockResolvedValue([{ id: 'd1', category: 'man_and_van' }]);
    const t = upsertDemandTool({ repos } as never);
    const out = await t.invoke(rc, JSON.stringify({ ...baseArgs, toPostcode: 'SE1' }));
    expect(out).toContain('updated');
    expect(repos.demands.update).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ toPostcode: 'SE1', sourceMessageId: 'm1' }),
    );
  });
});
