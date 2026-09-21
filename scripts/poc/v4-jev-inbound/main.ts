/**
 * V4 PoC — Jev 入站问题集 precision 与延迟。
 *
 * 路由说明（重要，见 RESULT.md）：直连 https://api.typesafe.ai/v1/systemone 用本仓库的
 * JEV_API_KEY 会返回 401 authentication_error；可用的路由是 OpenRouter 的 alpha decisions
 * 端点，它代理 TypeSafe。因此 URL 是 `${JEV_BASE_URL}/decisions`，不是 `/v1/systemone`。
 *
 * Run: set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v4-jev-inbound/main.ts
 * 可选：JEV_QUESTION_SET=v1|v2|v3 选问题集版本（默认 v3，即最终采用版）。
 */
import { readFileSync } from 'node:fs';

const DEMAND_CATEGORIES = [
  'man_and_van',
  'eot_cleaning',
  'furniture_service',
  'housing',
  'job',
  'second_hand',
  'other',
] as const;
type DemandCategory = (typeof DEMAND_CATEGORIES)[number];

type Labeled = {
  lang: string;
  group: string;
  text: string;
  is_demand: boolean;
  category: DemandCategory;
};

// ---------------------------------------------------------------------------
// 问题集。7 问，id 为 snake_case（AGENTS.md §4.4）；choice 的 option key 与
// packages/domain/src/demand.ts 的 DEMAND_CATEGORIES 逐字一致，不做二次映射。
// ---------------------------------------------------------------------------
type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<DemandCategory, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

const CATEGORY_CRITERIA: Record<DemandCategory, string> = {
  man_and_van: 'Moving home or transporting boxes/furniture by van, single-item delivery',
  eot_cleaning: 'End of tenancy, checkout, move-out or deep cleaning of a property',
  furniture_service: 'Furniture assembly, disassembly, mounting, delivery or disposal/clearance',
  housing: 'Looking for or offering a room, flat or house share',
  job: 'Looking for work or offering a job/shift to others',
  second_hand: 'Buying, selling or giving away used items',
  other: 'None of the above (chit-chat, questions, admin, currency exchange, news)',
};

const URGENCY_CRITERIA = [
  'No time given',
  'Within a week',
  'Within three days',
  'Tomorrow',
  'Today',
];

/** v0 = plan/P0-poc.md Task 4 Step 1 的**逐字**文案（含较短的 category criteria）。 */
const QUESTIONS_V0: Record<string, Question> = {
  is_demand: {
    type: 'noul',
    instructions:
      'Is the author asking for a paid local service (moving, cleaning, furniture assembly/removal) for themselves?',
    criteria: {
      true: 'Explicit request for a service',
      false: 'Chit-chat, offering a service, selling items, housing/job search',
    },
  },
  is_supply: {
    type: 'noul',
    instructions: 'Is the author OFFERING a service (has a van, can clean, can assemble)?',
  },
  category: {
    type: 'choice',
    instructions: 'Which category best fits the message?',
    criteria: {
      man_and_van: 'Moving, van, transport of boxes/furniture',
      eot_cleaning: 'End of tenancy / deep cleaning',
      furniture_service: 'Assembly, disassembly, furniture delivery or disposal',
      housing: 'Looking for or offering a room/flat',
      job: 'Looking for or offering work',
      second_hand: 'Buying or selling used items',
      other: 'None of the above',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How soon is the service needed?',
    criteria: URGENCY_CRITERIA,
  },
  has_location: {
    type: 'noul',
    instructions: 'Does the message contain a usable location (postcode, area, station)?',
  },
  is_sensitive: {
    type: 'noul',
    instructions:
      'Does the message involve currency exchange, crypto, or paying on someone\u2019s behalf?',
  },
  is_move_event: {
    type: 'noul',
    instructions:
      'Does the message imply the author is about to move home (looking for a room, leaving a tenancy, bought large furniture)?',
  },
};

/** v1 = v0，但 category criteria 展开为更完整的描述（本 PoC 作者补写）。 */
const QUESTIONS_V1: Record<string, Question> = {
  is_demand: {
    type: 'noul',
    instructions:
      'Is the author asking for a paid local service (moving, cleaning, furniture assembly/removal) for themselves?',
    criteria: {
      true: 'Explicit request for a service',
      false: 'Chit-chat, offering a service, selling items, housing/job search',
    },
  },
  is_supply: {
    type: 'noul',
    instructions: 'Is the author OFFERING a service (has a van, can clean, can assemble)?',
  },
  category: {
    type: 'choice',
    instructions: 'Which category best fits the message?',
    criteria: CATEGORY_CRITERIA,
  },
  urgency: {
    type: 'score',
    instructions: 'How soon is the service needed?',
    criteria: URGENCY_CRITERIA,
  },
  has_location: {
    type: 'noul',
    instructions: 'Does the message contain a usable location (postcode, area, station)?',
  },
  is_sensitive: {
    type: 'noul',
    instructions:
      'Does the message involve currency exchange, crypto, or paying on someone’s behalf?',
  },
  is_move_event: {
    type: 'noul',
    instructions:
      'Does the message imply the author is about to move home (looking for a room, leaving a tenancy, bought large furniture)?',
  },
};

/** v2 = 给每个 noul 都补上对称的 true/false criteria，并点明「为自己求助 vs 提供服务」。 */
const QUESTIONS_V2: Record<string, Question> = {
  ...QUESTIONS_V1,
  is_demand: {
    type: 'noul',
    instructions:
      'The author is a member of a London community Telegram group. Is this message the author asking OTHERS for a paid local service for themselves — man & van / moving, end of tenancy cleaning, or furniture assembly, delivery or removal? Asking the group to recommend a provider counts as asking.',
    criteria: {
      true: 'The author needs the service done for them and wants a provider, a recommendation or a quote. Counts even if the time or address is missing.',
      false:
        'The author OFFERS the service themselves, advertises their own van or cleaning business, is looking for a room or a flat, is looking for or offering a job, is buying or selling second-hand items, or is just chatting, asking for information or exchanging currency.',
    },
  },
  is_supply: {
    type: 'noul',
    instructions:
      'Is the author OFFERING to perform a local service for others (has a van, can clean, can assemble furniture), i.e. advertising themselves as the provider?',
    criteria: {
      true: 'The author can do the job for someone else, advertises their van, team, rates or availability.',
      false:
        'The author needs the service done for them, or the message is about housing, jobs, second-hand items or chit-chat.',
    },
  },
  has_location: {
    type: 'noul',
    instructions:
      'Does the message contain a usable London location — a UK postcode or outcode (E14, SE1, SW6), a borough or area name (Stratford, Ilford, Croydon), a station, or a zone?',
    criteria: {
      true: 'At least one postcode, outcode, area, borough or station is named.',
      false: 'No place is named, or only "London" / "anywhere" in general.',
    },
  },
};

/** v3 = v2 + category 明确「按消息主题分类，与是否求助无关」，修正 supply/job 的归类分歧。 */
const QUESTIONS_V3: Record<string, Question> = {
  ...QUESTIONS_V2,
  category: {
    type: 'choice',
    instructions:
      'Which category is this message about? Classify by SUBJECT MATTER only — a message offering a van and a message asking for a van are both man_and_van. If the author is looking for or offering work, choose job even when the work itself is cleaning or driving.',
    criteria: CATEGORY_CRITERIA,
  },
  urgency: {
    type: 'score',
    instructions:
      'How soon does the author need the service? Judge from the message only; if no time at all is mentioned, choose level 0.',
    criteria: URGENCY_CRITERIA,
  },
};

const QUESTION_SETS: Record<string, Record<string, Question>> = {
  v0: QUESTIONS_V0,
  v1: QUESTIONS_V1,
  v2: QUESTIONS_V2,
  v3: QUESTIONS_V3,
};

// ---------------------------------------------------------------------------
// 响应校验。手写校验而非 zod：根 node_modules 没有可解析的 zod，本 PoC 不新增依赖
// （AGENTS.md §9）。实际形状以 OpenRouter alpha decisions 的真实响应为准，与
// docs/reference/jev-decision-model.md §3.3 的差异记在 RESULT.md。
// ---------------------------------------------------------------------------
type NoulAnswer = { type: 'noul'; noul: number };
type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
type ScoreAnswer = {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
type JevResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
  id: string;
  provider: string;
};

class JevSchemaError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Jev response invalid at ${path}: ${detail}`);
    this.name = 'JevSchemaError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requireNumber(v: unknown, path: string, min?: number, max?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new JevSchemaError(path, `expected finite number, got ${JSON.stringify(v)}`);
  if (min !== undefined && v < min) throw new JevSchemaError(path, `expected >= ${min}, got ${v}`);
  if (max !== undefined && v > max) throw new JevSchemaError(path, `expected <= ${max}, got ${v}`);
  return v;
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new JevSchemaError(path, `expected non-empty string, got ${JSON.stringify(v)}`);
  return v;
}

function requireProbabilities(v: unknown, path: string): Record<string, number> {
  if (!isRecord(v)) throw new JevSchemaError(path, 'expected object');
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v)) out[k] = requireNumber(p, `${path}.${k}`, 0, 1);
  return out;
}

function parseAnswer(v: unknown, path: string): Answer {
  if (!isRecord(v)) throw new JevSchemaError(path, 'expected object');
  const type = requireString(v.type, `${path}.type`);
  if (type === 'noul') return { type, noul: requireNumber(v.noul, `${path}.noul`, 0, 1) };
  if (type === 'choice')
    return {
      type,
      choice: requireString(v.choice, `${path}.choice`),
      probabilities: requireProbabilities(v.probabilities, `${path}.probabilities`),
      confidence: requireNumber(v.confidence, `${path}.confidence`, 0, 1),
    };
  if (type === 'score') {
    if (!isRecord(v.legend)) throw new JevSchemaError(`${path}.legend`, 'expected object');
    return {
      type,
      score: requireNumber(v.score, `${path}.score`),
      legend: v.legend as Record<string, string>,
      probabilities: requireProbabilities(v.probabilities, `${path}.probabilities`),
      confidence: requireNumber(v.confidence, `${path}.confidence`, 0, 1),
    };
  }
  throw new JevSchemaError(`${path}.type`, `unknown answer type ${type}`);
}

function parseJevResponse(raw: unknown, expectedIds: string[]): JevResponse {
  if (!isRecord(raw)) throw new JevSchemaError('$', 'expected object');
  if (!isRecord(raw.answers)) throw new JevSchemaError('$.answers', 'expected object');
  if (!isRecord(raw.usage)) throw new JevSchemaError('$.usage', 'expected object');
  const answers: Record<string, Answer> = {};
  for (const id of expectedIds) {
    if (!(id in raw.answers))
      throw new JevSchemaError(`$.answers.${id}`, 'missing answer for asked question');
    answers[id] = parseAnswer(raw.answers[id], `$.answers.${id}`);
  }
  return {
    model: requireString(raw.model, '$.model'),
    answers,
    usage: {
      input_tokens: requireNumber(raw.usage.input_tokens, '$.usage.input_tokens', 0),
      output_tokens: requireNumber(raw.usage.output_tokens, '$.usage.output_tokens', 0),
      cost: requireNumber(raw.usage.cost, '$.usage.cost', 0),
    },
    id: requireString(raw.id, '$.id'),
    provider: requireString(raw.provider, '$.provider'),
  };
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------
const BASE_URL = process.env.JEV_BASE_URL ?? 'https://openrouter.ai/api/alpha';
const MODEL = process.env.JEV_MODEL ?? 'typesafe/jev-1.13';
const API_KEY = process.env.JEV_API_KEY;
const TIMEOUT_MS = 20_000;
const SET_NAME = process.env.JEV_QUESTION_SET ?? 'v3';

/** 阈值候选。AGENTS.md §4.4：正式代码里这个常量属于 packages/gating 配置表。 */
const T_IS_DEMAND_ENTER = Number(process.env.T_IS_DEMAND_ENTER ?? '0.7');

function die(msg: string): never {
  console.error(`\n[FATAL] ${msg}`);
  process.exit(1);
}

async function ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
  const url = `${BASE_URL}/decisions`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return parseJevResponse(await res.json(), Object.keys(questions));
    const body = await res.text();
    // 429 限流 / 529 过载：指数退避（docs/reference/jev-decision-model.md §3.4）
    if ((res.status === 429 || res.status === 529) && attempt < 4) {
      const waitMs = 500 * 2 ** attempt;
      console.error(`  HTTP ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/5)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    die(`POST ${url} -> HTTP ${res.status} ${res.statusText}\n${body}`);
  }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
const pct = (xs: number[], q: number): number =>
  xs[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');

function sweep(rows: Array<{ gold: boolean; noul: number }>): string[] {
  const out: string[] = [];
  for (const t of [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    let tp = 0,
      fp = 0,
      fn = 0;
    for (const r of rows) {
      const pred = r.noul >= t;
      if (pred && r.gold) tp++;
      else if (pred && !r.gold) fp++;
      else if (!pred && r.gold) fn++;
    }
    const p = tp + fp === 0 ? NaN : tp / (tp + fp);
    const rc = tp + fn === 0 ? NaN : tp / (tp + fn);
    const f1 =
      Number.isFinite(p) && Number.isFinite(rc) && p + rc > 0 ? (2 * p * rc) / (p + rc) : NaN;
    out.push(
      `  t=${t.toFixed(2)}  precision=${f2(p)} recall=${f2(rc)} f1=${f2(f1)}  tp=${tp} fp=${fp} fn=${fn}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
if (!API_KEY)
  die(
    'JEV_API_KEY is not set. Run with: set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v4-jev-inbound/main.ts',
  );
const questions =
  QUESTION_SETS[SET_NAME] ??
  die(
    `unknown JEV_QUESTION_SET=${SET_NAME}, expected one of ${Object.keys(QUESTION_SETS).join('|')}`,
  );

const labeled = JSON.parse(
  readFileSync(new URL('./labeled.json', import.meta.url), 'utf8'),
) as Labeled[];

console.log(
  `endpoint=${BASE_URL}/decisions  model=${MODEL}  question_set=${SET_NAME}  n=${labeled.length}  T_IS_DEMAND_ENTER=${T_IS_DEMAND_ENTER}`,
);

let tp = 0,
  fp = 0,
  fn = 0,
  tn = 0,
  catOk = 0,
  catOkDemand = 0,
  demandN = 0;
let inputTokens = 0,
  outputTokens = 0,
  totalCost = 0;
const lat: number[] = [];
const resolvedModels = new Set<string>();
const demandRows: Array<{ gold: boolean; noul: number }> = [];
const nouls: Record<string, number[]> = {};
const failures: string[] = [];
const catConfusion: Record<string, Record<string, number>> = {};

for (const [i, s] of labeled.entries()) {
  const t0 = Date.now();
  const r = await ask({ text: s.text, group: s.group }, questions);
  lat.push(Date.now() - t0);
  resolvedModels.add(r.model);
  inputTokens += r.usage.input_tokens;
  outputTokens += r.usage.output_tokens;
  totalCost += r.usage.cost;

  const a = r.answers;
  const isDemand = a.is_demand as NoulAnswer;
  const cat = a.category as ChoiceAnswer;
  const pred = isDemand.noul >= T_IS_DEMAND_ENTER;
  demandRows.push({ gold: s.is_demand, noul: isDemand.noul });
  if (pred && s.is_demand) tp++;
  else if (pred && !s.is_demand) fp++;
  else if (!pred && s.is_demand) fn++;
  else tn++;

  const catHit = cat.choice === s.category;
  if (catHit) catOk++;
  if (s.is_demand) {
    demandN++;
    if (catHit) catOkDemand++;
  }
  (catConfusion[s.category] ??= {})[cat.choice] =
    ((catConfusion[s.category] ??= {})[cat.choice] ?? 0) + 1;

  for (const [qid, ans] of Object.entries(a))
    if (ans.type === 'noul') (nouls[qid] ??= []).push(ans.noul);

  const ok = pred === s.is_demand && catHit;
  const line = `${String(i + 1).padStart(2)} ${ok ? 'ok ' : 'BAD'} ${s.lang} demand=${isDemand.noul.toFixed(2)}/${s.is_demand ? 'T' : 'F'} cat=${cat.choice}/${s.category} supply=${(a.is_supply as NoulAnswer).noul.toFixed(2)} urg=${(a.urgency as ScoreAnswer).score.toFixed(1)} loc=${(a.has_location as NoulAnswer).noul.toFixed(2)} sens=${(a.is_sensitive as NoulAnswer).noul.toFixed(2)} move=${(a.is_move_event as NoulAnswer).noul.toFixed(2)} | ${s.text.slice(0, 44)}`;
  console.log(line);
  if (!ok) failures.push(line);
}

lat.sort((x, y) => x - y);
const precision = tp / (tp + fp);
const recall = tp / (tp + fn);

console.log('\n================ SUMMARY ================');
console.log(`question_set=${SET_NAME}  resolved_model(s)=${[...resolvedModels].join(',')}`);
console.log(
  `is_demand @${T_IS_DEMAND_ENTER}: precision=${f2(precision)} recall=${f2(recall)} f1=${f2((2 * precision * recall) / (precision + recall))}  tp=${tp} fp=${fp} fn=${fn} tn=${tn}`,
);
console.log(
  `category_acc(all)=${f2(catOk / labeled.length)} (${catOk}/${labeled.length})   category_acc(true demands only)=${f2(catOkDemand / demandN)} (${catOkDemand}/${demandN})`,
);
console.log(
  `latency p50=${pct(lat, 0.5)}ms p95=${pct(lat, 0.95)}ms min=${lat[0]}ms max=${lat[lat.length - 1]}ms avg=${Math.round(mean(lat))}ms`,
);
console.log(
  `tokens: avg_input=${Math.round(inputTokens / labeled.length)} avg_output=${Math.round(outputTokens / labeled.length)}  total_cost=$${totalCost.toFixed(6)}  cost_per_msg=$${(totalCost / labeled.length).toFixed(8)}`,
);
console.log(
  `PASS CRITERIA (plan Task 4 Step 2): precision>=0.90 -> ${precision >= 0.9 ? 'PASS' : 'FAIL'};  p95<2000ms -> ${pct(lat, 0.95) < 2000 ? 'PASS' : 'FAIL'}`,
);

console.log('\n--- is_demand threshold sweep (for T_IS_DEMAND_ENTER) ---');
for (const l of sweep(demandRows)) console.log(l);
const posN = demandRows
  .filter((r) => r.gold)
  .map((r) => r.noul)
  .sort((a, b) => a - b);
const negN = demandRows
  .filter((r) => !r.gold)
  .map((r) => r.noul)
  .sort((a, b) => a - b);
console.log(
  `  gold=true  n=${posN.length} min=${f2(posN[0]!)} p05=${f2(pct(posN, 0.05))} median=${f2(pct(posN, 0.5))} max=${f2(posN[posN.length - 1]!)} mean=${f2(mean(posN))}`,
);
console.log(
  `  gold=false n=${negN.length} min=${f2(negN[0]!)} median=${f2(pct(negN, 0.5))} p95=${f2(pct(negN, 0.95))} max=${f2(negN[negN.length - 1]!)} mean=${f2(mean(negN))}`,
);

console.log('\n--- noul distributions (all questions) ---');
for (const [qid, xs] of Object.entries(nouls)) {
  const s = [...xs].sort((a, b) => a - b);
  console.log(
    `  ${qid.padEnd(14)} min=${f2(s[0]!)} p25=${f2(pct(s, 0.25))} median=${f2(pct(s, 0.5))} p75=${f2(pct(s, 0.75))} max=${f2(s[s.length - 1]!)}  >=0.7: ${xs.filter((x) => x >= 0.7).length}/${xs.length}`,
  );
}

console.log('\n--- category confusion (gold -> predicted) ---');
for (const [gold, preds] of Object.entries(catConfusion)) {
  console.log(
    `  ${gold.padEnd(18)} ${Object.entries(preds)
      .map(([p, c]) => `${p}:${c}`)
      .join('  ')}`,
  );
}

if (failures.length) {
  console.log(`\n--- ${failures.length} mismatched rows ---`);
  for (const l of failures) console.log(l);
}
