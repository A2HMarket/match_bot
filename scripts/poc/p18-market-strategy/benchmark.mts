/** P18 独立只读实验。先冻结题目与策略，再比较同一时刻的公开接口候选。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger } from '../../../packages/shared/src/index.js';
import { createMarketSearch } from '../../../packages/websearch/src/index.js';
const need = z.object({ id: z.string(), terms: z.array(z.string()) });
const caseSchema = z.object({
  id: z.string(),
  split: z.enum(['dev', 'holdout']),
  query: z.string(),
  tradeType: z.enum(['SELL', 'BUY', 'PEER']),
  intent: z.enum(['second_hand', 'housing', 'carry', 'companion']),
  baseline: z.string(),
  needs: z.array(need),
  queries: z.array(z.string()),
  preferences: z.array(z.string()),
  budget: z.number().optional(),
  requiredTerms: z.array(z.string()).optional(),
  excludeTerms: z.array(z.string()).optional(),
  dateRange: z.object({ from: z.string(), to: z.string() }).optional(),
  requiredArea: z.array(z.string()).optional(),
  route: z.object({ from: z.array(z.string()), to: z.array(z.string()) }).optional(),
});
const cases = z
  .array(caseSchema)
  .parse(JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')));
const output = process.argv[2] ?? '/tmp/p18-benchmark.json';
const batches: unknown[] = [];
let nullRepostNormalized = 0;
const service = createMarketSearch({
  logger: createLogger('p18', 'silent'),
  fetchImpl: async (url, init) => {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        'X-A2H-Agent': 'cli',
        'User-Agent': 'matchbot-strategy-benchmark/1.0',
      },
    });
    if (!res.ok) return res;
    const body: unknown = await res.json();
    // 真实自发帖的 repost=null 表示没有转载标记；原客户端会把一整页误报 unavailable。
    const shape = z
      .object({ data: z.object({ items: z.array(z.record(z.string(), z.unknown())) }) })
      .safeParse(body);
    if (shape.success)
      for (const item of shape.data.data.items)
        if (item['repost'] === null) {
          item['repost'] = false;
          nullRepostNormalized++;
        }
    return new Response(
      JSON.stringify(
        shape.success
          ? {
              ...(body as object),
              data: { ...(body as { data: object }).data, items: shape.data.data.items },
            }
          : body,
      ),
      { status: res.status, headers: { 'content-type': 'application/json' } },
    );
  },
});
const started = Date.now(),
  timer = setTimeout(() => process.exit(2), 300000);
const cache = new Map<string, unknown>();
for (const c of cases) {
  const results = [];
  for (const keyword of [...new Set([c.baseline, ...c.queries])]) {
    const key = JSON.stringify([keyword, c.tradeType]);
    let result = cache.get(key);
    if (!result) {
      try {
        result = {
          keyword,
          page: 1,
          ...(await service.find({ keyword, page: 1, tradeType: c.tradeType })),
        };
      } catch (e) {
        result = {
          keyword,
          errorKind: e instanceof Error ? e.name : 'Unknown',
          reason: e instanceof Error && 'reason' in e ? e.reason : null,
        };
      }
      cache.set(key, result);
    }
    results.push(result);
  }
  batches.push({ case: c, results });
  writeFileSync(
    output,
    JSON.stringify(
      {
        startedAt: new Date(started).toISOString(),
        elapsedMs: Date.now() - started,
        requests: cache.size,
        nullRepostNormalized,
        batches,
      },
      null,
      2,
    ),
  );
  process.stdout.write(JSON.stringify({ case: c.id, queries: results.length }) + '\n');
}
clearTimeout(timer);
