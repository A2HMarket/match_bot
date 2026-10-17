import { describe, expect, it, vi } from 'vitest';
import { createInboundHandler } from '../src/inbound.js';

const update = {
  update_id: 1,
  message: {
    message_id: 5,
    date: 1758800000,
    chat: { id: -100, type: 'supergroup', title: 'G' },
    from: { id: 42, is_bot: false, first_name: 'A' },
    text: 'need a van',
  },
} as never;

function deps(group: unknown) {
  return {
    botId: 1,
    repos: {
      groups: {
        findByExternal: vi.fn(() => Promise.resolve(group)),
        upsert: vi.fn(() => Promise.resolve({ id: 'g', isActive: false })),
      },
      users: { upsertByExternal: vi.fn(() => Promise.resolve({ id: 'user' })) },
      executions: {
        accept: vi.fn(() =>
          Promise.resolve({
            kind: 'accepted',
            message: { id: 'stored', executionStatus: 'accepted' },
          }),
        ),
        markEnqueued: vi.fn(() => Promise.resolve()),
      },
      traces: { create: vi.fn(() => Promise.resolve({})) },
    },
    queues: {},
    enqueueInbound: vi.fn(() => Promise.resolve()),
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never;
}

describe('createInboundHandler', () => {
  it('enqueues when group is active', async () => {
    const d = deps({ id: 'g', isActive: true });
    await createInboundHandler(d)(update);
    expect((d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ chatId: '-100', text: 'need a van' }),
    );
  });

  it('registers unknown group as inactive and does not enqueue', async () => {
    const d = deps(null);
    await createInboundHandler(d)(update);
    expect(
      (d as { repos: { groups: { upsert: ReturnType<typeof vi.fn> } } }).repos.groups.upsert,
    ).toHaveBeenCalledWith({ channel: 'telegram', externalId: '-100', name: 'G' });
    expect(
      (d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound,
    ).not.toHaveBeenCalled();
  });

  it('private chats always enqueue', async () => {
    const d = deps(null);
    const priv = {
      update_id: 2,
      message: {
        message_id: 6,
        date: 1758800000,
        chat: { id: 42, type: 'private', first_name: 'A' },
        from: { id: 42, is_bot: false, first_name: 'A' },
        text: 'hi',
      },
    } as never;
    await createInboundHandler(d)(priv);
    expect((d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound).toHaveBeenCalled();
  });
});
