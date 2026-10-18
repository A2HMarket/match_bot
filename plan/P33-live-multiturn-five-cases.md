import { expect, it, vi } from 'vitest';
import { openActorLab } from '../src/actor-lab-runtime.js';
import { actorLabConfigSchema, ACTOR_PROFILES } from '../src/actor-lab-config.js';
import { loadEnv } from '@matchbot/shared';
vi.mock('@matchbot/db', () => ({
  createPrisma: () => ({ $disconnect: () => Promise.resolve() }),
  createRepositories: () => ({ traces: { create: vi.fn() } }),
}));
vi.mock('@matchbot/agent', () => ({
  configureModelProvider: vi.fn(),
  createTraceProcessor: () => ({ forceFlush: () => Promise.resolve() }),
}));
vi.mock('@matchbot/jev', () => ({
  createJevClient: () => ({}),
  evaluateParticipantOutbound: vi.fn(),
}));
vi.mock(import('grammy'), async (importOriginal) => ({
  ...(await importOriginal()),
  Bot: class {
    botInfo: { id: number; is_bot: true; first_name: string; username: string; can_read_all_group_messages: boolean };
    constructor(readonly token: string) {
      const id = Number(token.split(':')[0]);
      this.botInfo = {
        id,
        is_bot: true,
        first_name:'Synthetic bot',
        username: id === 999999 ? 'match_bot' : `actor_${id}_bot`,
        can_read_all_group_messages: id === 999999,
      };
    }
    init() {
      throw new Error('SDK init retry loop must not be used');
    }
    isRunning() {
      return false;
    }
    api = {
      getMe: (_signal?:AbortSignal) => Promise.resolve(this.botInfo),
      getChat: () => Promise.resolve({ id: -123, type: 'group', title: 'A2H 测试' }),
      getChatMember: () => Promise.resolve({ status: 'member' }),
    };
  },
}));
it('verifies reply-only actors without requiring group-wide message access', async () => {
  const cfg = actorLabConfigSchema.parse({
    groupId: '-123',
    groupTitle: 'A2H 测试',
    matchBotId: '999999',
    matchBotUsername: 'match_bot',
    controlDatabaseUrl: 'postgresql://a:b@127.0.0.1/matchbot_actor_lab',
    actors: ACTOR_PROFILES.map((p, i) => ({
      id: String(111111 + i),
      username: `actor_${111111 + i}_bot`,
      token: `${111111 + i}:${'x'.repeat(32)}`,
      role: p.role,
      goal: p.goal,
      style: p.style,
      firstMessage: p.firstMessage,
    })),
  });
  const env = loadEnv({
    DATABASE_URL: 'postgresql://a:b@127.0.0.1/matchbot',
    REDIS_URL: 'redis://localhost:6379',
    DEEPSEEK_API_KEY: 'fixture',
    JEV_API_KEY: 'fixture',
    TELEGRAM_BOT_TOKEN: `999999:${'x'.repeat(32)}`,
    TELEGRAM_OPS_CHAT_ID: '-999',
    TELEGRAM_ACTOR_ALLOWLIST: JSON.stringify([
      { chatId: '-123', botIds: cfg.actors.map((a) => a.id) },
    ]),
  });
  const runtime = openActorLab(env, cfg);
  try {
    await expect(runtime.verify()).resolves.toBeUndefined();
  } finally {
    await runtime.close();
  }
});

修复后只读身份/成员核验已成功（无激活、无消息、无模型）。五场输入已落盘；总最多15条，频控无需扩权。当前预算待用户选择，未开始五场实测。

补复现：如果本条超时但曾有旧回复，旧控制器会拿旧回复生成新发言，已用假时钟测出并修复：当前请求无回复就结束该演员，不基于旧回复续聊。Main真实运行上界150秒且收尾最多30秒，P33等待改210秒覆盖收尾与发送；每场600秒上界不变。此为测试等待契约调整，不增模型研究预算或修改生产阈值。

准备验收：最终全量131文件/1093测试通过；build、12冻结多轮契约、92录制回放通过，批处理另按根strict配置单独noEmit类型检查。正式测试仍未开始，等待用户新增预算选择。批次有独立锁覆盖场景间隙；生成候选与发送分开记录，拒绝不重投；后续消息点明自己的需求，避免因跨账号无replyTo而拿不明上下文冒充自然接话。
