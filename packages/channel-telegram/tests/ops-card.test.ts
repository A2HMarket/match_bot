import { describe, expect, it, vi } from 'vitest';
import { createOpsCardSender, parseApprovalCallback, renderApprovalCard } from '../src/ops-card.js';

const card = {
  runStateId: 'rs_1',
  title: 'Man & Van · LONDON CITY · 0.94',
  draftText: '@Anna 3 options...',
  supplierLines: ['1. Van Co £40/h', '2. Move Ltd £55/h'],
  confidence: 0.94,
};

describe('renderApprovalCard', () => {
  it('includes title, draft, suppliers and three buttons', () => {
    const { text, keyboard } = renderApprovalCard(card);
    expect(text).toContain('Man & Van');
    expect(text).toContain('@Anna 3 options');
    expect(text).toContain('2. Move Ltd');
    const datas = keyboard.inline_keyboard
      .flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(datas).toEqual(['apv:rs_1:approve', 'apv:rs_1:reject', 'apv:rs_1:ignore']);
  });
});

describe('parseApprovalCallback', () => {
  it.each([
    ['apv:rs_1:approve', { runStateId: 'rs_1', decision: 'approve' }],
    ['apv:rs_1:reject', { runStateId: 'rs_1', decision: 'reject' }],
    ['apv:rs_1:edit', null],
    ['xyz', null],
  ])('%s', (data, expected) => {
    expect(parseApprovalCallback(data)).toEqual(expected);
  });
});

describe('createOpsCardSender', () => {
  it('sends to ops chat and returns message id', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ message_id: 77 }));
    const r = await createOpsCardSender({
      bot: { api: { sendMessage } } as never,
      opsChatId: '-200',
    }).sendApprovalCard(card);
    expect(r).toEqual({ messageId: '77' });
    expect(sendMessage).toHaveBeenCalledWith(
      -200,
      expect.any(String),
      expect.objectContaining<{ reply_markup: unknown }>({ reply_markup: expect.anything() }),
    );
  });
});
