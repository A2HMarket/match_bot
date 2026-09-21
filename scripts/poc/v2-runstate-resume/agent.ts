// PoC V2: 共享 agent 定义，pause.ts 与 resume.ts 两个进程都用它重建同一张 agent 图。
// 注意：根 node_modules 里没有 zod（它只是 @openai/agents 的 peer，未提升到根），
// 所以这里用 SDK 原生支持的 JsonObjectSchema 写工具参数，避免改 package.json。
import {
  Agent,
  OpenAIProvider,
  setDefaultModelProvider,
  setTracingDisabled,
  tool,
} from '@openai/agents';

setTracingDisabled(true);
setDefaultModelProvider(
  new OpenAIProvider({
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    useResponses: false,
  }),
);

export const sent: string[] = [];

export const replyInGroup = tool({
  name: 'reply_in_group',
  description: 'Send a reply into the Telegram group. This sends a message to real people.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The message to post in the group' } },
    required: ['text'],
    additionalProperties: false,
  } as const,
  needsApproval: true,
  execute: async (args: unknown) => {
    const { text } = args as { text: string };
    sent.push(text);
    return 'sent';
  },
});

export const buildAgent = () =>
  new Agent({
    name: 'poc-v2',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    instructions:
      'The user asks for a man & van. Reply in the group with two options using reply_in_group. Call the tool once.',
    tools: [replyInGroup],
  });
