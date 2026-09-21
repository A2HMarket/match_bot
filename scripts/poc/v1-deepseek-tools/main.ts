// scripts/poc/v1-deepseek-tools/main.ts
//
// V1 PoC: 验证 OpenAIProvider({ baseURL, useResponses: false }) + model 'deepseek-flash'
// 能否稳定通过 @openai/agents 调用 zod 参数工具。
//
// 运行：
//   set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v1-deepseek-tools/main.ts
//
// 注意：本脚本需要 zod@4.6.5 能从工作区根解析。最初它只作为 @openai/agents 的
// 传递依赖存在于 pnpm 虚拟 store 中，根上 import 'zod' 会 ERR_MODULE_NOT_FOUND；
// 现已由 `pnpm add -Dw zod@^4.6.5` 装到根 devDependencies。
// P8 的 packages/agent 仍必须把 zod 写成自己的显式 dependency（版本与 @openai/agents 对齐）。
import {
  Agent,
  OpenAIProvider,
  run,
  setDefaultModelProvider,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

setTracingDisabled(true);
setDefaultModelProvider(
  new OpenAIProvider({
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    useResponses: false,
  }),
);

const categories = [
  'man_and_van',
  'eot_cleaning',
  'furniture_service',
  'housing',
  'job',
  'second_hand',
  'other',
] as const;

const called: Array<{ tool: string; args: unknown }> = [];

// POC_OPTIONAL=1 -> 用 .optional() 代替 .nullable()，验证哪种写法在 strict schema 下可用。
const useOptional = process.env.POC_OPTIONAL === '1';
const nullableString = () => (useOptional ? z.string().optional() : z.string().nullable());
const nullableInt = () => (useOptional ? z.number().int().optional() : z.number().int().nullable());

const upsertDemand = tool({
  name: 'upsert_demand',
  description:
    "Record or update the user's service demand. Call this when the message asks for a service (man & van, cleaning, furniture assembly/removal).",
  parameters: z.object({
    category: z.enum(categories),
    whenText: nullableString(),
    fromPostcode: nullableString(),
    toPostcode: nullableString(),
    quantity: nullableString(),
    budgetPence: nullableInt(),
    lang: z.string().length(2),
  }),
  execute: async (args) => {
    called.push({ tool: 'upsert_demand', args });
    return 'recorded';
  },
});

const upsertSupply = tool({
  name: 'upsert_supply',
  description:
    'Record that the user OFFERS a service (has a van, can clean, can assemble). Not for people asking for help.',
  parameters: z.object({
    category: z.enum(categories),
    availability: nullableString(),
    area: nullableString(),
  }),
  execute: async (args) => {
    called.push({ tool: 'upsert_supply', args });
    return 'recorded';
  },
});

const doNothing = tool({
  name: 'do_nothing',
  description:
    'Call this when the message is not a service demand or offer (chit-chat, housing search, job search, selling items).',
  parameters: z.object({ reason: z.string() }),
  execute: async (args) => {
    called.push({ tool: 'do_nothing', args });
    return 'ok';
  },
});

// 变体开关：默认 = 计划里的原始配置（run_llm_again + 模型自由选择工具）。
//   POC_STOP_ON_FIRST_TOOL=1  -> toolUseBehavior: 'stop_on_first_tool'
//   POC_TOOL_CHOICE=required  -> modelSettings.toolChoice: 'required'
const stopOnFirstTool = process.env.POC_STOP_ON_FIRST_TOOL === '1';
const toolChoice = process.env.POC_TOOL_CHOICE;

const agent = new Agent({
  name: 'poc-v1',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  instructions:
    'You classify one Telegram group message. Call exactly one tool. Never reply with prose.',
  tools: [upsertDemand, upsertSupply, doNothing],
  ...(stopOnFirstTool ? { toolUseBehavior: 'stop_on_first_tool' as const } : {}),
  ...(toolChoice ? { modelSettings: { toolChoice } } : {}),
});

console.log(
  `config: model=${process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'} baseURL=${process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'} useResponses=false stopOnFirstTool=${stopOnFirstTool} toolChoice=${toolChoice ?? '(default)'} optionalInsteadOfNullable=${useOptional}`,
);

type Sample = { text: string; expectTool: string; expectCategory: string };
const samples = JSON.parse(
  readFileSync(new URL('./samples.json', import.meta.url), 'utf8'),
) as Sample[];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

let pass = 0;
const latencies: number[] = [];

for (const s of samples) {
  called.length = 0;
  const t0 = Date.now();
  let finalText = '';
  let err: string | undefined;
  try {
    const result = await run(agent, s.text);
    finalText = typeof result.finalOutput === 'string' ? result.finalOutput : '';
  } catch (e) {
    err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const ms = Date.now() - t0;
  latencies.push(ms);
  const first = called[0];
  const args = first?.args as { category?: string } | undefined;
  const ok =
    !err &&
    first?.tool === s.expectTool &&
    (s.expectTool === 'do_nothing' || args?.category === s.expectCategory);
  if (ok) pass++;
  const extra =
    called.length > 1
      ? `  [!! ${called.length} tool calls: ${called.map((c) => c.tool).join(',')}]`
      : '';
  const prose = !first && finalText ? `  [prose: ${JSON.stringify(finalText.slice(0, 120))}]` : '';
  const errStr = err ? `  [error: ${err}]` : '';
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${String(ms).padStart(6)}ms  ${s.text.slice(0, 50)}  -> ${first?.tool} ${JSON.stringify(first?.args)}${extra}${prose}${errStr}`,
  );
}

const sorted = [...latencies].sort((a, b) => a - b);
console.log(`\n${pass}/${samples.length} passed`);
console.log(
  `latency p50=${pct(sorted, 50)}ms p95=${pct(sorted, 95)}ms min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms`,
);
