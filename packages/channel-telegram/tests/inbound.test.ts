import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toInboundMessage } from '../src/inbound.js';
import type { Update } from 'grammy/types';

const load = (n: string): Update =>
  JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8')) as Update;

describe('toInboundMessage', () => {
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
  it('maps a private message without replyTo', () => {
    const m = toInboundMessage(load('update-private-text'), { botId: 111 });
    expect(m?.chatId).toBe('987654321');
    expect(m?.replyToMessageId).toBeUndefined();
  });
  it('returns null for non-text and for the bot itself', () => {
    expect(toInboundMessage(load('update-photo'), { botId: 111 })).toBeNull();
    const own = load('update-group-text');
    own.message!.from.id = 111;
    expect(toInboundMessage(own, { botId: 111 })).toBeNull();
  });
});
