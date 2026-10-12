import type { Logger } from '@matchbot/shared';
import { z } from 'zod';
import { assertSafeXhsKeyword } from './query.js';

/**
 * 一条小红书笔记候选。吃喝玩乐类需求的语料在小红书而不是 Tavily（2026-10-10 定位放宽：华人生活服务
 * 推荐几乎都在小红书）。笔记是 UGC，没有商家电话可核验，证据就是笔记本身的热度与正文。
 */
export interface XhsNote {
  /** 本次搜索内的编号（x1…）。回复工具只认编号，模型写不进结果以外的笔记。 */
  ref: string;
  title: string;
  /** 正文（图文详情接口的全文）。UGC 内容，交给模型前必须截断（见工具层）。 */
  desc: string;
  author: string;
  likes: number;
  url: string;
  /** 已获取匹配ID的详情正文；旧快照未带此元数据。 */
  isDetailLoaded?: boolean;
}

export class XhsSearchError extends Error {
  constructor(readonly reason: 'rate_limited' | 'http_error' | 'timeout' | 'invalid_response') {
    super('XHS source unavailable: ' + reason);
    this.name = 'XhsSearchError';
  }
}
export interface XhsSearch {
  find(p: {
    keyword: string;
    page?: 1 | 2;
    limit?: number;
    sort?: 'general' | 'time_descending';
    timeFilter?: '不限' | '半年内';
    excludeUrls?: string[];
    includeDetails?: boolean;
    reportErrors?: boolean;
  }): Promise<XhsNote[]>;
  readNote?(note: XhsNote): Promise<XhsNote | null>;
}

const BASE = 'https://api.sandbase.ai/v1/api/xiaohongshu/app-v2';
const MAX_NOTES = 10;
/** 正文交给模型的上限之外的余量；工具层还会再截。 */
const DESC_MAX = 2000;

const noteSchema = z.object({
  id: z.string(),
  xsec_token: z.string().default(''),
  title: z.string().default(''),
  desc: z.string().default(''),
  liked_count: z.coerce.number().int().nonnegative().default(0),
  user: z.object({ nickname: z.string().default('') }).default({ nickname: '' }),
});

// Sandbase 的同步Model API返回outputs[0].data；翻页ID在该payload外层（PoC 2026-10-10）。
const envelopeSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'timeout']),
  outputs: z.array(z.object({ data: z.unknown() })).min(1),
});
const searchResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(z.object({ model_type: z.string(), note: noteSchema.optional() })),
  }),
  search_id: z.string().optional(),
  search_session_id: z.string().optional(),
});

const detailResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({ note_list: z.array(noteSchema) })),
});

/**
 * 吃喝玩乐类需求的兜底：Sandbase search-notes 搜候选 → image-note-detail 逐个取全文。
 * 只搜图文笔记（note_type=普通笔记），视频笔记没有图文详情可取。
 * 与 Tavily 版同样的降级方向：任何一步失败都返回空，由工具层决定不回（§3.3 第 5 条精神）。
 */
export function createXhsSearch(p: {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** 共享请求间隔；测试注入 0，生产避免多主题详情请求突发限流。 */
  requestIntervalMs?: number;
}): XhsSearch {
  const fetchImpl = p.fetchImpl ?? fetch;
  let requestTail = Promise.resolve();
  let nextRequestAt = 0;
  const requestIntervalMs = p.requestIntervalMs ?? 350;
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const cursors = new Map<string, { searchId: string; sessionId: string; expiresAt: number }>();

  async function call(
    path: string,
    params: Record<string, string | number>,
    deadlineAt: number,
    onFailure?: (reason: 'rate_limited' | 'http_error' | 'timeout' | 'invalid_response') => void,
  ): Promise<unknown> {
    const previous = requestTail;
    let release: () => void = () => {};
    requestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() >= deadlineAt) {
          onFailure?.('timeout');
          return null;
        }
        const waitMs = Math.min(
          Math.max(0, nextRequestAt - Date.now()),
          Math.max(0, deadlineAt - Date.now()),
        );
        if (waitMs) await pause(waitMs);
        if (Date.now() >= deadlineAt) {
          onFailure?.('timeout');
          return null;
        }
        nextRequestAt = Date.now() + requestIntervalMs;
        try {
          const url = `${BASE}${path}`;
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadlineAt - Date.now()))),
          });
          if (res.ok) {
            const parsed = envelopeSchema.safeParse(await res.json());
            if (!parsed.success || parsed.data.status !== 'completed') {
              onFailure?.('invalid_response');
              p.logger.warn(
                { path, reason: parsed.success ? 'task_not_completed' : 'invalid_envelope' },
                'sandbase response unavailable',
              );
              return null;
            }
            return parsed.data.outputs[0]!.data;
          }
          onFailure?.(res.status === 429 ? 'rate_limited' : 'http_error');
          p.logger.warn({ status: res.status, path }, 'sandbase request failed');
          if (res.status >= 400 && res.status < 500 && res.status !== 429) return null;
          if (res.status === 429) {
            const seconds = Number(res.headers.get('retry-after'));
            const backoff =
              Number.isFinite(seconds) && seconds > 0 ? Math.min(5000, seconds * 1000) : 1500;
            nextRequestAt = Math.max(nextRequestAt, Date.now() + backoff);
          }
        } catch (e) {
          onFailure?.(e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'http_error');
          p.logger.warn(
            { errorKind: e instanceof Error ? e.name : 'UnknownError', path },
            'sandbase error',
          );
        }
      }
      return null;
    } finally {
      release();
    }
  }

  async function detail(
    id: string,
    deadlineAt: number,
  ): Promise<z.infer<typeof noteSchema> | null> {
    const raw = await call('/image-note-detail', { note_id: id }, deadlineAt);
    if (!raw) return null;
    const parsed = detailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      p.logger.warn({ path: 'image-note-detail' }, 'sandbase response failed schema');
      return null;
    }
    return (
      parsed.data.data.flatMap((item) => item.note_list).find((note) => note.id === id) ?? null
    );
  }

  return {
    async readNote(note) {
      const url = new URL(note.url);
      if (url.origin !== 'https://www.xiaohongshu.com' || !/^\/explore\/[\w-]+$/.test(url.pathname))
        return null;
      const full = await detail(url.pathname.split('/').at(-1)!, Date.now() + 30000);
      if (!full || !full.desc) return null;
      return {
        ...note,
        title: full.title || note.title,
        desc: full.desc.slice(0, DESC_MAX),
        author: full.user.nickname || note.author,
        likes: full.liked_count || note.likes,
        isDetailLoaded: true,
      };
    },
    async find(q) {
      const deadlineAt = Date.now() + 30_000;
      const keyword = assertSafeXhsKeyword(q.keyword);
      // 小红书是中文语料：关键词里没提伦敦就补「伦敦」，而不是 Tavily 那样的英文 London
      const query = /伦敦|倫敦|london/i.test(keyword) ? keyword : `${keyword} 伦敦`;
      const cursorKey = JSON.stringify([query, q.sort ?? 'general', q.timeFilter ?? '不限']);
      const cursor = cursors.get(cursorKey);
      if (q.page === 2 && (!cursor || cursor.expiresAt < Date.now())) {
        p.logger.warn(
          { keyword: query },
          'xhs pagination unavailable; search page one with the same filters first',
        );
        return [];
      }
      let failure: XhsSearchError['reason'] = 'invalid_response';
      const raw = await call(
        '/search-notes',
        {
          keyword: query,
          page: q.page ?? 1,
          note_type: '普通笔记',
          sort_type: q.sort ?? 'general',
          time_filter: q.timeFilter ?? '不限',
          ...(q.page === 2 && cursor
            ? { search_id: cursor.searchId, search_session_id: cursor.sessionId }
            : {}),
        },
        deadlineAt,
        (reason) => {
          failure = reason;
        },
      );
      if (!raw) {
        if (q.reportErrors) throw new XhsSearchError(failure);
        return [];
      }
      const parsed = searchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        if (q.reportErrors) throw new XhsSearchError('invalid_response');
        p.logger.warn({ path: 'search-notes' }, 'sandbase response failed schema');
        return [];
      }
      const data = parsed.data;
      if (data.search_id && data.search_session_id) {
        if (cursors.size >= 100) cursors.delete(cursors.keys().next().value ?? '');
        cursors.set(cursorKey, {
          searchId: data.search_id,
          sessionId: data.search_session_id,
          expiresAt: Date.now() + 900_000,
        });
      }
      const items = data.data.items;
      const seen = new Set((q.excludeUrls ?? []).map((url) => new URL(url).pathname));
      const candidates = items
        .filter((i) => i.model_type === 'note')
        .map((i) => i.note)
        .filter((n): n is z.infer<typeof noteSchema> => n !== undefined && n.title.length > 0)
        .filter((n) => {
          const key = `/explore/${n.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, Math.min(MAX_NOTES, Math.max(1, q.limit ?? 8)));
      const enrich = async (n: z.infer<typeof noteSchema>) => {
        // 详情失败就退回搜索摘要里的字段，不为一条笔记丢掉整次搜索
        const d = q.includeDetails === false ? null : await detail(n.id, deadlineAt);
        const full = d ?? n;
        return {
          title: full.title || n.title,
          desc: (full.desc || n.desc).slice(0, DESC_MAX),
          author: full.user.nickname || n.user.nickname,
          likes: full.liked_count || n.liked_count,
          url: `https://www.xiaohongshu.com/explore/${n.id}${
            n.xsec_token ? `?xsec_token=${encodeURIComponent(n.xsec_token)}` : ''
          }`,
          isDetailLoaded: !!d?.desc,
        };
      };
      const enriched: Array<Awaited<ReturnType<typeof enrich>>> = [];
      for (let offset = 0; offset < candidates.length; offset += 4) {
        enriched.push(...(await Promise.all(candidates.slice(offset, offset + 4).map(enrich))));
      }
      const out = enriched.map((n, i) => ({ ...n, ref: `x${i + 1}` }));
      p.logger.info({ provider: 'sandbase', keyword: query, notes: out.length }, 'xhs search done');
      return out;
    },
  };
}
