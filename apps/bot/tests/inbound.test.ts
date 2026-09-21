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
        findByExternal: vi.fn(async () => group),
        upsert: vi.fn(async () => ({ id: 'g', isActive: false })),
      },
    },
    queues: {},
    enqueueInbound: vi.fn(async () => {}),
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
      ...update,
      message: { ...update.message, chat: { id: 42, type: 'private', first_name: 'A' } },
    } as never;
    await createInboundHandler(d)(priv);
    expect((d as { enqueueInbound: ReturnType<typeof vi.fn> }).enqueueInbound).toHaveBeenCalled();
  });
});
