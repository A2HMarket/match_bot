import { z } from 'zod';

/** 进程启动时一次性校验环境变量。任何模块不得直接读 process.env。 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  JEV_API_KEY: z.string().min(1),
  // Jev 经 OpenRouter 的 decisions 端点；客户端拼 `${JEV_BASE_URL}/decisions`（PoC V4 结论，
  // 见 plan/P0-poc.md「对后续工作包的跨项结论」第 2 条）。直连 api.typesafe.ai 需要另一把 key。
  JEV_BASE_URL: z.string().url().default('https://openrouter.ai/api/alpha'),
  JEV_MODEL: z.string().default('typesafe/jev-1.13'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OPS_CHAT_ID: z.string().min(1),
  DEFAULT_PHASE: z.coerce.number().int().min(0).max(2).default(0),
  // run_states.snapshot 落库加密口令（AGENTS.md §6）。Phase 0 无审批中断用不到，故 optional；
  // 一旦进入 Phase 1（产生中断快照）就必须配置，否则 runInbound 在写快照时报错。
  SNAPSHOT_KEY: z.string().min(16).optional(),
  // Phase 2 里出站门拿不准（分数居中 / Jev 不可用 / 触发频控）时怎么办。
  // drop = 不发，无人值守时用；review = 送运营群审批，有人值守时用。
  // P14 库外需求兜底搜索（Tavily）。不配则不启用，库外需求一律不回。
  SEARCH_API_KEY: z.string().min(1).optional(),
  OUTBOUND_UNSURE_ACTION: z.enum(['drop', 'review']).default('drop'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
