/**
 * 最小 ModelProvider 替身。手写协议对象而不是 import `@openai/agents/testing`：
 * AGENTS.md §3.2 只允许 `packages/agent` 直接依赖 `@openai/agents`，apps/worker 连测试里也不碰。
 * 形状对齐 SDK 的 `assistantMessage` / `functionCall`
 * （@openai/agents-core/dist/testing/scriptedModel.mjs）与 `ModelResponse`。
 */

export function textMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

export function functionCall(name: string, callId: string, args: Record<string, unknown>) {
  return {
    type: 'function_call',
    name,
    callId,
    status: 'completed',
    arguments: JSON.stringify(args),
  };
}

const emptyUsage = () => ({
  requests: 1,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokensDetails: [],
  outputTokensDetails: [],
  requestUsageEntries: [],
});

/** 每次调用消费一条脚本；脚本耗尽即抛，避免测试因模型多转一圈而静默变形。 */
export function scriptedProvider(script: Array<unknown[]>) {
  let i = 0;
  const model = {
    getResponse: () => {
      const output = script[i++];
      if (!output) throw new Error(`scripted model ran out of steps after ${i - 1} calls`);
      return Promise.resolve({ output, usage: emptyUsage(), responseId: `resp-${i}` });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    getStreamedResponse: async function* () {
      throw new Error('streaming is not scripted');
    },
  };
  return { getModel: () => model, remaining: () => script.length - i };
}
