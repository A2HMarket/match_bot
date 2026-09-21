import { describe, expect, it, vi } from 'vitest';
import { createPgSession } from '../src/session.js';

function repos() {
  const store: unknown[] = [];
  return {
    store,
    sessionItems: {
      list: vi.fn((_u: string, limit?: number) =>
        Promise.resolve(limit ? store.slice(-limit) : [...store]),
      ),
      append: vi.fn((_u: string, items: unknown[]) => {
        store.push(...items);
        return Promise.resolve();
      }),
      popLast: vi.fn(() => Promise.resolve(store.pop() ?? null)),
      clear: vi.fn(() => {
        store.length = 0;
        return Promise.resolve();
      }),
    },
  };
}

describe('createPgSession', () => {
  it('delegates to sessionItems repo with the user id', async () => {
    const r = repos();
    const s = createPgSession({ repos: r as never, userId: 'u1' });
    expect(await s.getSessionId()).toBe('u1');
    await s.addItems([{ role: 'user', content: 'hi' }] as never);
    expect(await s.getItems()).toHaveLength(1);
    expect(await s.popItem()).toEqual({ role: 'user', content: 'hi' });
    await s.clearSession();
    expect(await s.getItems()).toEqual([]);
  });

  it('popItem returns undefined (not null) on empty history (PoC V3 SDK signature)', async () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    expect(await s.popItem()).toBeUndefined();
  });

  it('strips providerData (deepseek reasoning_content) before persisting', async () => {
    const r = repos();
    const s = createPgSession({ repos: r as never, userId: 'u1' });
    await s.addItems([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'ok', providerData: { reasoning_content: 'chain' } },
        ],
      },
    ] as never);
    expect(r.store[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    });
  });

  it('strips providerData again on replay via prepareHistoryItemForModelInput', () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    const item = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', providerData: { reasoning_content: 'chain' } }],
    } as never;
    const out = s.prepareHistoryItemForModelInput?.(item) as { content: object[] };
    expect(out.content[0]).toEqual({ type: 'output_text', text: 'ok' });
  });

  it('trims history to 40 items without splitting a function_call pair', async () => {
    const r = repos();
    const s = createPgSession({ repos: r as never, userId: 'u1' });
    const items = Array.from({ length: 45 }, (_, i) => ({ type: 'message', n: i }));
    // 把第 6 条（裁剪后应为第 1 条）变成 function_call_output，验证窗口会后移避开拆对
    items[5] = { type: 'function_call_output', n: 5 };
    r.store.push(...items);
    const got = (await s.getItems()) as Array<{ n: number }>;
    expect(got).toHaveLength(39);
    expect(got[0]?.n).toBe(6);
  });
});
