import type { Env } from '@matchbot/shared';
import {
  OpenAIProvider,
  setDefaultModelProvider,
  setTraceProcessors,
  type TracingProcessor,
} from '@openai/agents';

/**
 * deepseek-flash 走 Chat Completions（useResponses: false，架构 §4.1）。
 * setTraceProcessors 是整体替换（PoC V6：addTraceProcessor 才是追加）——调用后不再导出到 OpenAI。
 * 只在进程启动时调一次。
 */
export function configureModelProvider(env: Env, processors: TracingProcessor[]): void {
  setTraceProcessors(processors);
  setDefaultModelProvider(
    new OpenAIProvider({
      baseURL: env.DEEPSEEK_BASE_URL,
      apiKey: env.DEEPSEEK_API_KEY,
      useResponses: false,
    }),
  );
}
