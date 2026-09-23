import { describe, expect, it, vi } from 'vitest';
import { createApprovalCallbackHandler } from '../src/approval-callback.js';

const OPS = '-5372233317';

function setup(result: 'queued' | 'ignored' | 'invalid') {
  const handle = vi.fn(() => Promise.resolve(result));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const h = createApprovalCallbackHandler({
    repos: {} as never,
    queues: {} as never,
    opsChatId: OPS,
    logger: logger as never,
    handle: handle,
  });
  return { h, handle };
}

describe('createApprovalCallbackHandler', () => {
  it('approves from the ops chat and passes the reviewer through', async () => {
    const { h, handle } = setup('queued');
    const r = await h({ data: 'apv:rs_1:approve', chatId: Number(OPS), reviewer: '@ops' });
    expect(r.outcome).toBe('approved');
    expect(r.stamp).toBe('✅ 已批准 · @ops');
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: '@ops', data: 'apv:rs_1:approve' }),
    );
  });

  it('reports reject as rejected (the run still resumes to receive the refusal)', async () => {
    const { h } = setup('queued');
    expect((await h({ data: 'apv:rs_1:reject', chatId: Number(OPS), reviewer: 'x' })).outcome).toBe(
      'rejected',
    );
  });

  it('refuses callbacks from any chat other than the ops chat, without touching the snapshot', async () => {
    const { h, handle } = setup('queued');
    const r = await h({ data: 'apv:rs_1:approve', chatId: -1001, reviewer: 'x' });
    expect(r.outcome).toBe('forbidden');
    expect(r.stamp).toBeNull();
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses callbacks with no originating chat', async () => {
    const { h, handle } = setup('queued');
    expect((await h({ data: 'apv:rs_1:approve', chatId: undefined, reviewer: 'x' })).outcome).toBe(
      'forbidden',
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('tells a second click on approve that the card is stale', async () => {
    const { h } = setup('ignored'); // 快照已被第一次点击消费
    expect(
      (await h({ data: 'apv:rs_1:approve', chatId: Number(OPS), reviewer: 'x' })).outcome,
    ).toBe('stale');
  });

  it('distinguishes a deliberate ignore from a stale card', async () => {
    const { h } = setup('ignored');
    expect((await h({ data: 'apv:rs_1:ignore', chatId: Number(OPS), reviewer: 'x' })).outcome).toBe(
      'ignored',
    );
  });

  it('rejects malformed callback data before any lookup', async () => {
    const { h, handle } = setup('queued');
    const r = await h({ data: 'apv:../../x:approve', chatId: Number(OPS), reviewer: 'x' });
    expect(r.outcome).toBe('invalid');
    expect(r.stamp).toBeNull();
    expect(handle).not.toHaveBeenCalled();
  });
});
