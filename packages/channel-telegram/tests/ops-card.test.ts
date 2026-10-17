import { describe, expect, it } from 'vitest';
import {
  approvalKeyboard,
  parseApprovalCallback,
  renderApprovalCard,
  stampApprovalCardText,
} from '../src/ops-card.js';

const card = {
  runStateId: 'rs_1',
  title: 'Man & Van · LONDON CITY · 0.94',
  draftText: '@Anna 3 options...',
  supplierLines: ['1. Van Co £40/h', '2. Move Ltd £55/h'],
  confidence: 0.94,
};

it('adds the reviewer stamp when it fits, preserving the full reviewed body when it does not', () => {
  expect(stampApprovalCardText('完整正文', '✅ 已批准')).toBe('完整正文\n\n✅ 已批准');
  const full = '字'.repeat(4096);
  expect(stampApprovalCardText(full, '✅ 已批准')).toBe(full);
});

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

it('refuses a callback identity that cannot fit the trusted approval button', () => {
  expect(approvalKeyboard('rs_1').inline_keyboard.flat()).toHaveLength(3);
  expect(() => approvalKeyboard('x'.repeat(100))).toThrow();
});
