import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '@matchbot/shared';
import { createDeepSeekSearch } from '../src/deepseek-search.js';
const row = (url = 'https://www.nhs.uk/register') => ({
  title: 'Registration',
  url,
  snippet: 'Short excerpt',
  summary: 'Official registration policy',
  content: 'You do not need an NHS number.',
  site_name: null,
  site_icon: null,
  date: null,
  authority: 3,
  rerank_score: 2.5,
});
const setup = (fetchImpl: typeof fetch) =>
  createDeepSeekSearch({
    apiKey: 'fixture-key',
    logger: createLogger('test', 'silent'),
    fetchImpl,
  });
describe('DeepSeek raw search adapter', () => {
  it('requests content with a domain operator and filters the returned domains locally', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [row(), row('https://example.org/irrelevant')] })),
      );
    const result = await setup(f).research!({
      query: 'GP registration NHS number',
      domains: ['nhs.uk'],
    });
    expect(result.status).toBe('ok');
    expect(result.sources[0]?.url).toBe('https://www.nhs.uk/register');
    expect(result.sources[0]?.text).toContain('do not need');
    expect(result.sources).toHaveLength(1);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(typeof init?.body).toBe('string');
    const body: unknown = JSON.parse(init?.body as string);
    expect(body).toEqual({
      query: 'GP registration NHS number site:nhs.uk',
      need_content: true,
      count: 5,
    });
  });
  it.each([401, 402, 429, 503])(
    'preserves HTTP %i as unavailable rather than empty success, without retries',
    async (status) => {
      const f = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
      expect(await setup(f).research!({ query: 'GP registration' })).toMatchObject({
        status: 'unavailable',
        reason: status === 429 ? 'rate_limited' : 'http_error',
      });
      expect(f).toHaveBeenCalledOnce();
    },
  );
  it('distinguishes a valid empty result, malformed response and timeout', async () => {
    expect(
      await setup(vi.fn().mockResolvedValue(new Response('{"results":[]}'))).research!({
        query: 'GP registration',
      }),
    ).toEqual({ status: 'ok', sources: [] });
    expect(
      await setup(vi.fn().mockResolvedValue(new Response('{"results":[{}]}'))).research!({
        query: 'GP registration',
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid_response' });
    expect(
      await setup(vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'))).research!(
        { query: 'GP registration' },
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });
  it('does not accept unsafe result URLs or claim verified businesses from search snippets', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [row('http://127.0.0.1/private')] })),
      );
    expect((await setup(f).research!({ query: 'London local service' })).sources).toEqual([]);
    expect(await setup(f).find({ need: 'cleaner' })).toEqual([]);
  });
});
