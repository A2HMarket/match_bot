import { describe, expect, it, vi } from 'vitest';
import { publishApproval } from '../src/publish.js';

const runState = {
  id: 'rs1',
  userId: 'u',
  interruptions: [
    {
      tool: 'reply_in_group',
      args: JSON.stringify({ text: '@Anna 3 options', supplierIds: ['a', 'b'] }),
    },
  ],
} as never;

describe('publishApproval', () => {
  it('renders supplier lines from repo and sends one card', async () => {
    const cards = { sendApprovalCard: vi.fn().mockResolvedValue({ messageId: '9' }) };
    const repos = {
      suppliers: {
        findByIds: vi.fn().mockResolvedValue([
          { id: 'a', name: 'Van Co', roughPrice: '£40/h', pool: 'A' },
          { id: 'b', name: 'Move Ltd', roughPrice: null, pool: 'B' },
        ]),
      },
      demands: {
        findOpenByUser: vi.fn().mockResolvedValue([{ category: 'man_and_van', confidence: 0.94 }]),
      },
    } as never;
    await publishApproval({ repos, cards, runState });
    expect(cards.sendApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({
        runStateId: 'rs1',
        draftText: '@Anna 3 options',
        supplierLines: ['1. Van Co £40/h (A)', '2. Move Ltd (B)'],
        confidence: 0.94,
      }),
    );
  });

  it('does nothing when there are no interruptions', async () => {
    const cards = { sendApprovalCard: vi.fn().mockResolvedValue({ messageId: '9' }) };
    const repos = {
      suppliers: { findByIds: vi.fn() },
      demands: { findOpenByUser: vi.fn().mockResolvedValue([]) },
    } as never;
    await publishApproval({
      repos,
      cards,
      runState: { id: 'rs2', userId: 'u', interruptions: [] } as never,
    });
    expect(cards.sendApprovalCard).not.toHaveBeenCalled();
  });
});
