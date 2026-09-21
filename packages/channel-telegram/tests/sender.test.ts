import { describe, expect, it, vi } from 'vitest';
import { createTelegramSender, TelegramSendError } from '../src/sender.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const msg = {
  id: 'om1',
  channel: 'telegram',
  target: '-100',
  text: 'hi',
  status: 'pending',
  toolCallId: null,
  error: null,
  createdAt: new Date(),
  sentAt: null,
} as never;

describe('createTelegramSender', () => {
  it('calls bot.api.sendMessage with numeric chat id and disabled link preview', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ message_id: 1 }));
    await createTelegramSender({ bot: { api: { sendMessage } } as never, logger }).send(msg);
    expect(sendMessage).toHaveBeenCalledWith(
      -100,
      'hi',
      expect.objectContaining({ link_preview_options: { is_disabled: true } }),
    );
  });
  it('wraps api errors', async () => {
    const sendMessage = vi.fn(() => Promise.reject(new Error('403: bot was kicked')));
    await expect(
      createTelegramSender({ bot: { api: { sendMessage } } as never, logger }).send(msg),
    ).rejects.toBeInstanceOf(TelegramSendError);
  });
});
