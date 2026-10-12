/** A组小红书独立发现与全文读取，不使用Bot规划。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger, loadEnv } from '../../../packages/shared/src/index.js';
import { createXhsSearch, redactMarketText } from '../../../packages/websearch/src/index.js';
const cases = z
  .object({
    cases: z.array(
      z.object({ id: z.string(), aSource: z.string(), aInitialQueries: z.array(z.string()) }),
    ),
  })
  .parse(JSON.parse(readFileSync('scripts/poc/p21-london-ab/cases.json', 'utf8'))).cases;
const env = loadEnv();
if (!env.SANDBASE_API_KEY) throw new Error('Missing Sandbase configuration');
const search = createXhsSearch({
  apiKey: env.SANDBASE_API_KEY,
  logger: createLogger('ab-direct-xhs', 'silent'),
});
const batches: Array<Record<string, unknown>> = [];
for (const c of cases.filter((row) => row.aSource === 'XHS')) {
  const started = Date.now();
  const queries = [];
  const notes = new Map<
    string,
    { title: string; desc: string; url: string; ref: string; isDetailLoaded?: boolean }
  >();
  for (const keyword of c.aInitialQueries.slice(0, 2)) {
    const found = await search.find({
      keyword,
      limit: 6,
      includeDetails: false,
      timeFilter: '半年内',
    });
    queries.push({ keyword, returned: found.length });
    for (const n of found)
      notes.set(new URL(n.url).pathname, {
        ref: n.ref,
        title: n.title,
        desc: redactMarketText(n.desc),
        url: n.url,
        ...(n.isDetailLoaded !== undefined ? { isDetailLoaded: n.isDetailLoaded } : {}),
      });
  }
  const first = [...notes.values()].slice(0, 2);
  for (const n of first) {
    const d = await search.readNote?.({ ...n, author: '', likes: 0 });
    if (d)
      notes.set(new URL(d.url).pathname, {
        ref: d.ref,
        title: d.title,
        desc: redactMarketText(d.desc),
        url: d.url,
        isDetailLoaded: true,
      });
  }
  batches.push({
    case: c.id,
    source: 'Sandbase Xiaohongshu',
    elapsedMs: Date.now() - started,
    queries,
    notes: [...notes.values()],
  });
  writeFileSync('/tmp/p21-a-xhs.json', JSON.stringify(batches, null, 2));
  process.stdout.write(JSON.stringify({ case: c.id, notes: notes.size, queries }) + '\n');
}
