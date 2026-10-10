/** 新接口只读PoC：仅记录响应形状与计数；密钥/原始API错误正文不输出。 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';

const env = loadEnv(),
  logger = createLogger('sandbase-probe');
if (!env.SANDBASE_API_KEY) throw new Error('SANDBASE_API_KEY is required');
const envelope = z.object({
  status: z.string(),
  outputs: z.array(z.object({ data: z.unknown() })).optional(),
});
const note = z.object({
  id: z.string(),
  type: z.string().optional(),
  xsec_token: z.string().default(''),
  title: z.string().default(''),
  desc: z.string().default(''),
  liked_count: z.coerce.number().default(0),
  user: z.object({ nickname: z.string().default('') }).optional(),
});
const search = z.object({
  success: z.boolean(),
  data: z.object({
    items: z.array(z.object({ model_type: z.string().optional(), note: note.optional() })),
  }),
  search_id: z.string().optional(),
  search_session_id: z.string().optional(),
  next_page: z.number().optional(),
});
const detail = z.object({
  success: z.boolean(),
  data: z.array(z.object({ note_list: z.array(note) })),
});
const results: unknown[] = [];
async function call(path: string, params: Record<string, unknown>) {
  const started = Date.now();
  const res = await fetch(`https://api.sandbase.ai/v1/api/xiaohongshu/app-v2/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SANDBASE_API_KEY!}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  const body = envelope.safeParse(await res.json());
  logger.info(
    {
      path,
      status: res.status,
      elapsedMs: Date.now() - started,
      envelopeValid: body.success,
      taskStatus: body.success ? body.data.status : undefined,
    },
    'probe response',
  );
  if (!res.ok || !body.success || body.data.status !== 'completed')
    throw new Error('Sandbase request did not complete');
  return body.data.outputs?.[0]?.data;
}
try {
  const first = search.parse(
    await call('search-notes', {
      keyword: '伦敦 看展',
      page: 1,
      note_type: '普通笔记',
      sort_type: 'general',
      time_filter: '不限',
    }),
  );
  if (!first.success) throw new Error('upstream search failed');
  results.push({ kind: 'search', ...first });
  logger.info(
    {
      notes: first.data.items.length,
      hasSearchId: !!first.search_id,
      hasSessionId: !!first.search_session_id,
    },
    'search schema confirmed',
  );
  const candidate = first.data.items.find((i) => i.model_type === 'note' && i.note?.id)?.note;
  if (candidate) {
    const full = detail.parse(await call('image-note-detail', { note_id: candidate.id }));
    results.push({ kind: 'detail', ...full });
    logger.info(
      {
        matchesRequestedId: full.data.some((i) => i.note_list.some((n) => n.id === candidate.id)),
        notes: full.data.flatMap((i) => i.note_list).length,
      },
      'detail schema confirmed',
    );
  }
  if (first.search_id && first.search_session_id) {
    const second = search.parse(
      await call('search-notes', {
        keyword: '伦敦 看展',
        page: 2,
        note_type: '普通笔记',
        sort_type: 'general',
        time_filter: '不限',
        search_id: first.search_id,
        search_session_id: first.search_session_id,
      }),
    );
    results.push({ kind: 'page2', ...second });
    logger.info({ notes: second.data.items.length }, 'page two schema confirmed');
  }
} catch (e) {
  logger.error({ errorKind: e instanceof Error ? e.name : 'unknown' }, 'probe failed');
  process.exitCode = 1;
} finally {
  writeFileSync('/tmp/matchbot-sandbase-probe.json', JSON.stringify(results, null, 2));
}
