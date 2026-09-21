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
  JEV_BASE_URL: z.string().url().default('https://api.typesafe.ai'),
  JEV_MODEL: z.string().default('jev-latest'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OPS_CHAT_ID: z.string().min(1),
  DEFAULT_PHASE: z.coerce.number().int().min(0).max(2).default(0),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
