import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../src/client.js';

const ok = readFileSync(new URL('./fixtures/inbound-ok.json', import.meta.url), 'utf8');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const traces = { create: vi.fn(() => Promise.resolve({} as never)), listByKind: vi.fn() };
const questions = {
  is_demand: { type: 'noul' as const, instructions: 'x' },
  category: {
    type: 'choice' as const,
    instructions: 'y',
    criteria: { man_and_van: null, other: null },
  },
};
const mk = (fetchImpl: typeof fetch) =>
  createJevClient({
    baseUrl: 'https://jev.test',
    apiKey: 'k',
    model: 'jev-latest',
    traces,
    logger,
    fetchImpl,
    timeoutMs: 50,
  });

describe('createJevClient', () => {
  it('returns typed answers and writes a trace with cost', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(ok, { status: 200 })),
    ) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({
      state: { text: 'van' },
      questions,
      inputRef: 'm1',
      phase: 0,
    });
    expect(r.ok && r.answers.category.type === 'choice' && r.answers.category.choice).toBe(
      'man_and_van',
    );
    expect(traces.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'jev', inputRef: 'm1', costMicro: Math.round(412 * 0.042) }),
    );
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });
  it('retries on 429 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(ok, { status: 200 })) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm2', phase: 0 });
    expect(r.ok).toBe(true);
  });
  it('gives up after 3 retries with rate_limited', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('', { status: 529 })),
    ) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm3', phase: 0 });
    expect(r).toEqual({ ok: false, reason: 'rate_limited' });
  });
  it('returns timeout when fetch hangs', async () => {
    const fetchImpl = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init.signal?.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError')),
          ),
        ),
    ) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm4', phase: 0 });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });
  it('returns invalid_response on malformed body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('{"answers":{}}', { status: 200 })),
    ) as unknown as typeof fetch;
    const r = await mk(fetchImpl).evaluate({ state: 's', questions, inputRef: 'm5', phase: 0 });
    expect(r).toEqual({ ok: false, reason: 'invalid_response' });
  });
});
