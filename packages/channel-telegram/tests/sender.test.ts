import { describe, expect, it, vi } from 'vitest';
import { createTelegramSender, TelegramSendError, withMention } from '../src/sender.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const msg = {
  id: 'om1',
  channel: 'telegram',
  target: '-100',
  text: 'hi',
  status: 'pending',
  toolCallId: null,
  kind: 'recommendation',
  replyToMessageId: null,
  mentionUserId: null,
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

describe('group replies', () => {
  const reply = { ...(msg as object), replyToMessageId: '77', mentionUserId: '42' } as never;
  const member = (user: object) => vi.fn(() => Promise.resolve({ status: 'member', user }));

  it.each([
    { id: 42, is_bot: false, first_name: '🙂小王' },
    { id: 42, is_bot: false, first_name: 'Ann', username: 'ann_l' },
  ])(
    'preserves recommendation links and bold offsets alongside mentions: $first_name',
    async (user) => {
      const sendMessage = vi.fn(() => Promise.resolve({ message_id: 1 }));
      const url = 'https://www.xiaohongshu.com/explore/abc?xsec_token=tok';
      await createTelegramSender({
        bot: { api: { sendMessage, getChatMember: member(user) } } as never,
        logger,
      }).send({
        ...(reply as object),
        text: `先看这个：\n\n1. 河边集市\n来源：[小红书原文](${url}) · 作者`,
      } as never);
      const [, text, options] = sendMessage.mock.calls[0] as unknown as [
        number,
        string,
        { entities: Array<{ type: string; offset: number; length: number; url?: string }> },
      ];
      expect(text).not.toContain('xsec_token');
      const link = options.entities.find((e) => e.type === 'text_link');
      expect(link).toMatchObject({ offset: text.indexOf('小红书原文'), length: 5, url });
      expect(options.entities.find((e) => e.type === 'bold')).toMatchObject({
        offset: text.indexOf('1. 河边集市'),
        length: 7,
      });
    },
  );

  it('replies to the source message and @mentions an author who has a username', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ message_id: 1 }));
    const getChatMember = member({ id: 42, is_bot: false, first_name: 'Ann', username: 'ann_l' });
    await createTelegramSender({
      bot: { api: { sendMessage, getChatMember } } as never,
      logger,
    }).send(reply);
    expect(getChatMember).toHaveBeenCalledWith(-100, 42);
    expect(sendMessage).toHaveBeenCalledWith(
      -100,
      '@ann_l hi',
      expect.objectContaining({
        reply_parameters: { message_id: 77, allow_sending_without_reply: true },
      }),
    );
  });

  it('falls back to a plain reply when the author cannot be looked up', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ message_id: 1 }));
    const getChatMember = vi.fn(() => Promise.reject(new Error('400: user not found')));
    await createTelegramSender({
      bot: { api: { sendMessage, getChatMember } } as never,
      logger,
    }).send(reply);
    const [, text, opts] = sendMessage.mock.calls[0] as unknown as [number, string, object];
    expect(text).toBe('hi');
    expect(opts).toHaveProperty('reply_parameters');
    expect(opts).not.toHaveProperty('entities');
  });
});

describe('withMention', () => {
  it('uses a text_mention entity when the author has no username', () => {
    const r = withMention('请问什么时候搬？', { id: 42, first_name: '小王' });
    expect(r.text).toBe('小王 请问什么时候搬？');
    const [e] = r.entities ?? [];
    expect(e).toMatchObject({ type: 'text_mention', offset: 0, length: 2 });
    expect(e?.type === 'text_mention' ? e.user.id : null).toBe(42);
  });
  it('measures the entity in UTF-16 units so emoji names do not shift the mention', () => {
    const r = withMention('hi', { id: 1, first_name: '🙂Li' });
    expect(r.entities?.[0]?.length).toBe(4);
  });
});

describe('reactions', () => {
  it('sets an emoji reaction on the target message instead of sending text', async () => {
    const sendMessage = vi.fn();
    const setMessageReaction = vi.fn(() => Promise.resolve(true));
    await createTelegramSender({
      bot: { api: { sendMessage, setMessageReaction } } as never,
      logger,
    }).send({ ...(msg as object), kind: 'reaction', text: '👍', replyToMessageId: '77' } as never);
    expect(setMessageReaction).toHaveBeenCalledWith(-100, 77, [{ type: 'emoji', emoji: '👍' }]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('fails loudly when a reaction has no target message', async () => {
    await expect(
      createTelegramSender({ bot: { api: {} } as never, logger }).send({
        ...(msg as object),
        kind: 'reaction',
        text: '👍',
      } as never),
    ).rejects.toBeInstanceOf(TelegramSendError);
  });
});
