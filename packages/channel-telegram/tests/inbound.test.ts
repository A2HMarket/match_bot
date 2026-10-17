import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toInboundMessage } from '../src/inbound.js';
import type { Update } from 'grammy/types';

const load = (n: string): Update =>
  JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8')) as Update;

describe('toInboundMessage', () => {
  it('admits only an explicitly configured actor in its configured group', () => {
    const update = load('update-group-text');
    update.message!.from.is_bot = true;
    const actorAllowlist = [{ chatId: '-1001234567890', botIds: ['987654321'] }];
    expect(toInboundMessage(update, { botId: 111, actorAllowlist })?.userId).toBe('987654321');
    expect(toInboundMessage(update, { botId: 111 })).toBeNull();
    expect(
      toInboundMessage(update, {
        botId: 111,
        actorAllowlist: [{ chatId: '-999', botIds: ['987654321'] }],
      }),
    ).toBeNull();
    expect(
      toInboundMessage(update, {
        botId: 111,
        actorAllowlist: [{ chatId: '-1001234567890', botIds: ['222'] }],
      }),
    ).toBeNull();
    expect(toInboundMessage(update, { botId: 987654321, actorAllowlist })).toBeNull();
    update.message!.chat.type = 'private';
    expect(toInboundMessage(update, { botId: 111, actorAllowlist })).toBeNull();
  });
  it('maps a group text message', () => {
    const m = toInboundMessage(load('update-group-text'), { botId: 111 });
    expect(m).toEqual({
      channel: 'telegram',
      chatId: '-1001234567890',
      messageId: '55',
      userId: '987654321',
      text: 'I need someone with a van this Sunday, moving from E14 to SE1',
      lang: 'en',
      replyToMessageId: '50',
      receivedAt: '2025-09-25T11:33:20.000Z',
    });
  });
  it('maps a private message without replyTo, as addressed to the bot', () => {
    const m = toInboundMessage(load('update-private-text'), { botId: 111 });
    expect(m?.chatId).toBe('987654321');
    expect(m?.replyToMessageId).toBeUndefined();
    expect(m?.addressedToBot).toBe(true);
  });
  it('keeps photo album captions and caption mentions in the text pipeline', () => {
    const m = toInboundMessage(load('update-photo-caption'), {
      botId: 111,
      botUsername: 'london_match_bot',
    });
    expect(m?.text).toBe('@London_Match_Bot 出 s 码全新衣服');
    expect(m?.addressedToBot).toBe(true);
    expect(m?.messageId).toBe('56');
  });
  it('recognizes a caption text_mention pointing to the bot', () => {
    const u = load('update-photo-caption');
    Object.assign(u.message!, {
      caption: 'Bot 出 s 码全新衣服',
      caption_entities: [
        {
          type: 'text_mention',
          offset: 0,
          length: 3,
          user: { id: 111, is_bot: true, first_name: 'Bot' },
        },
      ],
    });
    expect(toInboundMessage(u, { botId: 111 })?.addressedToBot).toBe(true);
  });
  it('returns null for non-text and for the bot itself', () => {
    expect(toInboundMessage(load('update-photo'), { botId: 111 })).toBeNull();
    const own = load('update-group-text');
    own.message!.from.id = 111;
    expect(toInboundMessage(own, { botId: 111 })).toBeNull();
  });
});

describe('toInboundMessage — talking to the bot', () => {
  const BOT = { botId: 111, botUsername: 'london_match_bot' };
  const base = (): Update => load('update-group-text');

  it("flags a reply to one of the bot's messages and carries the bot text as context", () => {
    const u = base();
    Object.assign(u.message!, {
      text: '这家周末开吗',
      reply_to_message: {
        message_id: 50,
        date: 1,
        chat: u.message!.chat,
        from: { id: 111, is_bot: true, first_name: 'Bot' },
        text: 'Tian Tian Market（instagram.com/tiantianmarket）',
      },
    });
    const m = toInboundMessage(u, BOT);
    expect(m?.addressedToBot).toBe(true);
    expect(m?.replyToBotText).toContain('Tian Tian Market');
  });

  it('flags an @mention of the bot, case-insensitively', () => {
    const u = base();
    Object.assign(u.message!, {
      text: '@London_Match_Bot 你是谁',
      entities: [{ type: 'mention', offset: 0, length: 17 }],
      reply_to_message: undefined,
    });
    expect(toInboundMessage(u, BOT)?.addressedToBot).toBe(true);
  });

  it('does not flag a reply to another member, nor carry their text', () => {
    const u = base();
    Object.assign(u.message!, {
      reply_to_message: {
        message_id: 50,
        date: 1,
        chat: u.message!.chat,
        from: { id: 222, is_bot: false, first_name: 'Ann' },
        text: 'private stuff from Ann',
      },
    });
    const m = toInboundMessage(u, BOT);
    expect(m?.addressedToBot).toBeUndefined();
    expect(m?.replyToBotText).toBeUndefined();
  });

  it('does not flag a mention of somebody else', () => {
    const u = base();
    Object.assign(u.message!, {
      text: '@someone_else hi',
      entities: [{ type: 'mention', offset: 0, length: 13 }],
      reply_to_message: undefined,
    });
    expect(toInboundMessage(u, BOT)?.addressedToBot).toBeUndefined();
  });
});
