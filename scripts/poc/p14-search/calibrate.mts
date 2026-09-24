/**
 * P14：校准 is_local_request 阈值。发送的是生产同一套入站问题（含新题），顺带检查
 * 加题后 is_demand / category 是否漂移。
 *   set -a; . ./.env; set +a; pnpm exec tsx scripts/poc/p14-search/calibrate.mts <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inboundQuestions } from '../../../packages/jev/src/questions/inbound.ts';

type S = {
  id: string;
  lang: string;
  text: string;
  group?: string;
  is_local_request: boolean;
  is_demand?: boolean;
  category?: string;
};
const base = JSON.parse(readFileSync('packages/eval/fixtures/labeled-inbound.json', 'utf8'));
const baseSamples = (Array.isArray(base) ? base : base.samples) as (S & { is_demand: boolean })[];
const extra = JSON.parse(readFileSync('scripts/poc/p14-search/labeled-local.json', 'utf8'))
  .samples as S[];
const samples: S[] = [
  ...baseSamples.map((s) => ({
    ...s,
    is_local_request: s.is_demand || s.id === 's25' || s.id === 's46',
  })),
  ...extra,
];

const out: unknown[] = [];
let cost = 0;
for (const s of samples) {
  const res = await fetch(`${process.env.JEV_BASE_URL}/decisions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.JEV_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.JEV_MODEL,
      state: {
        text: s.text,
        group: s.group ?? 'London community group',
        lang: s.lang,
        recent_messages_from_author: [],
      },
      questions: inboundQuestions(),
    }),
  });
  const j = (await res.json()) as {
    answers?: Record<string, { noul?: number; choice?: string }>;
    usage?: { cost: number };
  };
  cost += j.usage?.cost ?? 0;
  const a = j.answers ?? {};
  out.push({
    id: s.id,
    lang: s.lang,
    label: s.is_local_request,
    local: a.is_local_request?.noul ?? null,
    isDemand: a.is_demand?.noul ?? null,
    labelDemand: s.is_demand ?? null,
    category: a.category?.choice ?? null,
    labelCategory: s.category ?? null,
    text: s.text.slice(0, 50),
  });
}
writeFileSync(process.argv[2]!, JSON.stringify({ cost, out }, null, 1));
process.stderr.write(`n=${out.length} cost=$${cost.toFixed(5)}\n`);
