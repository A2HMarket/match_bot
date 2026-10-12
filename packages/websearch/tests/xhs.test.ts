import { describe, expect, it, vi } from 'vitest';
import { UnsafeQueryError } from '../src/query.js';
import { createXhsSearch } from '../src/xhs.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function note(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    xsec_token: 'tok 1',
    title: '伦敦圣诞集市攻略',
    desc: '搜索摘要里的正文',
    liked_count: 40,
    user: { nickname: '大智' },
    ...over,
  };
}

function wrapPayload(payload: unknown, status = 'completed') {
  return {
    id: 'fixture-run',
    model: 'xiaohongshu/app-v2/search-notes',
    status,
    outputs: [{ data: payload }],
  };
}
function searchBody(notes: unknown[], pagination: Record<string, unknown> = {}) {
  return wrapPayload({
    code: 0,
    success: true,
    data: { items: notes.map((n) => ({ model_type: 'note', note: n })) },
    ...pagination,
  });
}
function detailBody(n: Record<string, unknown>) {
  return wrapPayload({ code: 0, success: true, data: [{ model_type: 'note', note_list: [n] }] });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function readBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected JSON string body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** 按 URL 路由的 stub fetch；calls 收集每次请求的 URL。 */
function stubFetch(handlers: {
  search?: (() => Response) | Response;
  detail?: (() => Response) | Response;
}) {
  const calls: string[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    requests.push({ url, init });
    const h = url.includes('search-notes') ? handlers.search : handlers.detail;
    const r = typeof h === 'function' ? h() : h;
    return Promise.resolve(r ?? jsonResponse({}, 500));
  };
  return { f: f as never as typeof fetch, calls, requests };
}

describe('createXhsSearch', () => {
  it('reports 429 explicitly for the answering agent, retaining the legacy empty-array contract', async () => {
    const modern = stubFetch({ search: jsonResponse({}, 429) });
    await expect(
      createXhsSearch({ apiKey: 'k', logger, fetchImpl: modern.f, requestIntervalMs: 0 }).find({
        keyword: '伦敦展览',
        reportErrors: true,
      }),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
    const legacy = stubFetch({ search: jsonResponse({}, 429) });
    await expect(
      createXhsSearch({ apiKey: 'k', logger, fetchImpl: legacy.f, requestIntervalMs: 0 }).find({
        keyword: '伦敦展览',
      }),
    ).resolves.toEqual([]);
  });

  it('discovers cards without fetching all details, then hydrates only selected notes with stable refs', async () => {
    const { f, calls } = stubFetch({
      search: jsonResponse(searchBody([note(), note({ id: 'n2', title: '候选乙' })])),
      detail: jsonResponse(detailBody(note({ desc: '入选笔记的完整正文' }))),
    });
    const service = createXhsSearch({ apiKey: 'k', requestIntervalMs: 0, logger, fetchImpl: f });
    const cards = await service.find({ keyword: '伦敦 看展', includeDetails: false });
    expect(calls).toHaveLength(1);
    expect(cards[0]?.isDetailLoaded).toBe(false);
    const full = await service.readNote!(cards[0]!);
    expect(calls).toHaveLength(2);
    expect(full).toMatchObject({
      ref: 'x1',
      desc: '入选笔记的完整正文',
      url: cards[0]!.url,
      isDetailLoaded: true,
    });
  });
  it.each(['pending', 'failed', 'timeout'])(
    'rejects non-completed Sandbase status %s without consuming a payload',
    async (status) => {
      const body = searchBody([note()]);
      body.status = status;
      const { f, calls } = stubFetch({ search: jsonResponse(body) });
      const out = await createXhsSearch({
        apiKey: 'k',
        requestIntervalMs: 0,
        logger,
        fetchImpl: f,
      }).find({ keyword: '伦敦 看展' });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(1);
    },
  );
  it('rejects upstream failure even with a completed envelope and note-shaped data', async () => {
    const { f, calls } = stubFetch({
      search: jsonResponse(
        wrapPayload({
          success: false,
          code: 400,
          data: { items: [{ model_type: 'note', note: note() }] },
        }),
      ),
    });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({ keyword: '伦敦 看展' });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
  });
  it('does not retry rejected credentials or log an API error body', async () => {
    const captured = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { f, calls } = stubFetch({
      search: jsonResponse({ error: { message: 'secret-key-in-error' } }, 401),
    });
    await createXhsSearch({
      apiKey: 'secret-key-in-error',
      requestIntervalMs: 0,
      logger: captured,
      fetchImpl: f,
    }).find({ keyword: '伦敦 看展' });
    expect(calls).toHaveLength(1);
    expect(
      JSON.stringify([
        captured.info.mock.calls,
        captured.warn.mock.calls,
        captured.error.mock.calls,
      ]),
    ).not.toContain('secret-key-in-error');
  });
  it('uses search text when detail returns another note, and never substitutes that unrelated note', async () => {
    const { f } = stubFetch({
      search: jsonResponse(searchBody([note()])),
      detail: jsonResponse(detailBody(note({ id: 'other-note', desc: 'unrelated-body' }))),
    });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({ keyword: '伦敦 看展' });
    expect(out[0]?.desc).toBe('搜索摘要里的正文');
  });
  it('backs off after 429 and serializes requests across simultaneous topic searches', async () => {
    vi.useFakeTimers();
    try {
      const times: number[] = [];
      const fetchImpl = vi.fn(() => {
        times.push(Date.now());
        return Promise.resolve(
          times.length === 1
            ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
            : jsonResponse(searchBody([])),
        );
      });
      const service = createXhsSearch({ apiKey: 'k', logger, fetchImpl, requestIntervalMs: 350 });
      const pending = Promise.all([
        service.find({ keyword: '伦敦 看展' }),
        service.find({ keyword: '伦敦 摄影' }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(351);
      await pending;
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(350);
    } finally {
      vi.useRealTimers();
    }
  });
  it('carries search/session IDs to page two with the same filters and deduplicates before fetching detail', async () => {
    const calls: Array<{ url: URL; body: Record<string, unknown> }> = [];
    const fetchImpl = (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = readBody(init);
      calls.push({ url, body });
      if (url.pathname.endsWith('search-notes')) {
        return Promise.resolve(
          jsonResponse(
            searchBody(
              [note(), note({ id: 'n2', title: '展览乙' }), note({ id: 'n2', title: '重复' })],
              {
                search_id: 'search1',
                search_session_id: 'session1',
              },
            ),
          ),
        );
      }
      return Promise.resolve(jsonResponse(detailBody(note({ id: body['note_id'] }))));
    };
    const service = createXhsSearch({ apiKey: 'k', requestIntervalMs: 0, logger, fetchImpl });
    await service.find({
      keyword: '伦敦 2026年10月 看展',
      sort: 'time_descending',
      timeFilter: '半年内',
      limit: 8,
    });
    const out = await service.find({
      keyword: '伦敦 2026年10月 看展',
      page: 2,
      sort: 'time_descending',
      timeFilter: '半年内',
      excludeUrls: ['https://www.xiaohongshu.com/explore/n1?xsec_token=old'],
    });
    const second = calls.filter((c) => c.url.pathname.endsWith('search-notes'))[1]!.body;
    expect(second['page']).toBe(2);
    expect(second['search_id']).toBe('search1');
    expect(second['search_session_id']).toBe('session1');
    expect(second['sort_type']).toBe('time_descending');
    expect(second['time_filter']).toBe('半年内');
    expect(out).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname.endsWith('image-note-detail'))).toHaveLength(3);
  });

  it('returns up to ten candidates with longer bounded bodies, rather than five', async () => {
    const { f } = stubFetch({
      search: jsonResponse(
        searchBody(Array.from({ length: 15 }, (_, i) => note({ id: `n${i + 1}` }))),
      ),
      detail: () => jsonResponse(detailBody(note({ desc: 'x'.repeat(3000) }))),
    });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({
      keyword: '伦敦 看展',
      limit: 10,
    });
    expect(out).toHaveLength(10);
    expect(out[0]?.desc.length).toBe(2000);
  });

  it('searches notes, enriches with note detail, and returns structured refs', async () => {
    const { f, calls, requests } = stubFetch({
      search: jsonResponse(searchBody([note()])),
      detail: jsonResponse(detailBody({ ...note(), desc: '详情接口的全文', liked_count: 88 })),
    });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({
      keyword: '圣诞集市',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ref: 'x1',
      title: '伦敦圣诞集市攻略',
      desc: '详情接口的全文',
      author: '大智',
      likes: 88,
    });
    // 链接带 xsec_token（编码后），点得开
    expect(out[0]!.url).toBe('https://www.xiaohongshu.com/explore/n1?xsec_token=tok%201');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.headers).toEqual({
      authorization: 'Bearer k',
      'content-type': 'application/json',
    });
    expect(calls[0]).toBe('https://api.sandbase.ai/v1/api/xiaohongshu/app-v2/search-notes');
    expect(readBody(requests[0]?.init)).toMatchObject({
      keyword: '圣诞集市 伦敦',
      page: 1,
      note_type: '普通笔记',
    });
    expect(calls[1]).toContain('/image-note-detail');
    expect(readBody(requests[1]?.init)).toEqual({ note_id: 'n1' });
  });

  it('does not append 伦敦 when the keyword already mentions London', async () => {
    const { f, requests } = stubFetch({
      search: jsonResponse(searchBody([note()])),
      detail: jsonResponse(detailBody(note())),
    });
    await createXhsSearch({ apiKey: 'k', requestIntervalMs: 0, logger, fetchImpl: f }).find({
      keyword: '伦敦川菜',
    });
    expect(readBody(requests[0]?.init)).toMatchObject({ keyword: '伦敦川菜' });
  });

  it('skips items without a note or without a title', async () => {
    const { f } = stubFetch({
      search: jsonResponse(
        wrapPayload({
          code: 0,
          success: true,
          data: {
            items: [
              { model_type: 'user', user: {} },
              { model_type: 'note', note: note({ title: '' }) },
              { model_type: 'note', note: note({ id: 'n2', title: '有标题' }) },
              { model_type: 'ads', note: note({ id: 'ad', title: '广告' }) },
            ],
          },
        }),
      ),
      detail: jsonResponse(detailBody(note({ id: 'n2', title: '有标题' }))),
    });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({
      keyword: '圣诞集市',
    });
    expect(out.map((n) => n.ref)).toEqual(['x1']);
    expect(out[0]!.title).toBe('有标题');
  });

  it('falls back to search-result fields when the detail call fails', async () => {
    const { f } = stubFetch({
      search: jsonResponse(searchBody([note()])),
      detail: () => jsonResponse({}, 500),
    });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({
      keyword: '圣诞集市',
    });
    expect(out[0]).toMatchObject({ desc: '搜索摘要里的正文', likes: 40 });
  });

  it('returns nothing when search keeps failing, after one retry', async () => {
    const { f, calls } = stubFetch({ search: () => jsonResponse({}, 500) });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({
      keyword: '圣诞集市',
    });
    expect(out).toEqual([]);
    expect(calls.filter((u) => u.includes('search-notes'))).toHaveLength(2);
  });

  it('returns nothing when the response does not match the schema', async () => {
    const { f } = stubFetch({ search: jsonResponse({ unexpected: true }) });
    const out = await createXhsSearch({
      apiKey: 'k',
      requestIntervalMs: 0,
      logger,
      fetchImpl: f,
    }).find({
      keyword: '圣诞集市',
    });
    // 形状不符但 zod 收窄后 items 为空 = 没有可用候选，不崩
    expect(out).toEqual([]);
  });

  it('rejects queries that look like personal information before they leave the process', async () => {
    const { f, calls } = stubFetch({});
    await expect(
      createXhsSearch({ apiKey: 'k', requestIntervalMs: 0, logger, fetchImpl: f }).find({
        keyword: '联系我 07700 900123',
      }),
    ).rejects.toThrow(UnsafeQueryError);
    expect(calls).toHaveLength(0);
  });
});
