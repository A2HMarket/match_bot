import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
const id = z.string().regex(/^[1-9]\d*$/);
export const actorLabConfigSchema = z
  .strictObject({
    groupId: z.string().regex(/^-\d+$/),
    groupTitle: z
      .string()
      .min(1)
      .max(100)
      .refine((s) => /A2H.*(?:测试|演练|lab)/i.test(s)),
    matchBotId: id,
    matchBotUsername: z.string().regex(/^[A-Za-z0-9_]+bot$/i),
    controlDatabaseUrl: z.url().refine((s) => {
      const u = new URL(s);
      return (
        ['127.0.0.1', 'localhost'].includes(u.hostname) &&
        u.pathname === '/matchbot_actor_lab' &&
        ['postgresql:', 'postgres:'].includes(u.protocol)
      );
    }),
    actors: z
      .array(
        z
          .strictObject({
            id,
            username: z.string().regex(/^[A-Za-z0-9_]+bot$/i),
            token: z.string().regex(/^\d{6,}:[A-Za-z0-9_-]{30,}$/),
            role: z.enum(['short', 'changes', 'interruption']),
            goal: z.string().min(1).max(1000),
            style: z.string().min(1).max(300),
            firstMessage: z.string().min(1).max(180),
          })
          .refine((a) => a.token.startsWith(a.id + ':')),
      )
      .length(3),
    maxMessages: z.number().int().min(1).max(12).default(6),
    maxSeconds: z.number().int().min(30).max(600).default(600),
    tokenBudget: z.number().int().min(1000).max(500000).default(150000),
    waitForEachReply: z.boolean().default(false),
    minRemainingTokens: z.number().int().nonnegative().max(500000).default(0),
    replyWaitSeconds: z.number().int().min(5).max(160).default(150),
  })
  .refine(
    (c) =>
      new Set(c.actors.map((a) => a.id)).size === 3 &&
      new Set(c.actors.map((a) => a.role)).size === 3 &&
      !c.actors.some((a) => a.id === c.matchBotId),
  );
export type ActorLabConfig = z.infer<typeof actorLabConfigSchema>;
export function loadActorLabConfig(path: string): ActorLabConfig {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('actor_config_must_be_private_0600');
  try {
    return actorLabConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    throw new Error('invalid_actor_lab_configuration');
  }
}
export const ACTOR_PROFILES = [
  {
    role: 'short',
    name: '小林 · 短句测试',
    goal: '在E14收一张书桌和一把办公椅，每件50镑以内，自己坐地铁自提。被问路程时单程最多半小时。',
    style: '口语短句，逐次补充，不重复整套需求。',
    firstMessage: 'E14想收书桌和办公椅，每件50镑以内',
  },
  {
    role: 'changes',
    name: '小周 · 改条件测试',
    goal: 'Stratford找一居室，月租1600镑以内，11月5日入住，养猫必须允许。希望包账单，但总预算不能提高。',
    style: '先说核心需求，按实际追问补充猫和账单；不接受预算被偷换。',
    firstMessage: 'Stratford想找一居室，月租1600镑以内，11月入住',
  },
  {
    role: 'interruption',
    name: '阿明 · 插话测试',
    goal: 'E14找周末羽毛球搭子，自己是初学者，只能周日下午，想要室内。',
    style: '在别人对话中提出自己的独立需求；只回应自己的事，不替其他人回答。',
    firstMessage: '插个话，E14有周末羽毛球搭子吗？我是新手',
  },
] as const;
