import type { Repositories } from '@matchbot/db';
import type { DemandDraft, Phase } from '@matchbot/domain';
import type { Thresholds } from '@matchbot/gating';
import type { evaluateOutbound, JevClient } from '@matchbot/jev';
import type { Env, Logger } from '@matchbot/shared';
import type { ModelProvider } from '@openai/agents';

/** 一次 run 的上下文。Session 粒度是用户；群上下文与开放需求经这里 + instructions 注入。 */
export interface MatchContext {
  userId: string;
  chatId: string;
  groupId: string | null;
  phase: Phase;
  sourceMessageId: string;
  /**
   * 触发这次 run 的那条消息在渠道侧的 id 与作者 id（sourceMessageId / userId 是库内 id）。
   * 群内回帖用它回复原消息并 @ 作者；私聊回复发给这个作者。可选：旧快照里没有。
   */
  source?: { messageId: string; userId: string };
  demandId?: string;
  demand?: DemandDraft;
  recentReplies: string[];
}

export interface AgentDeps {
  env: Env;
  repos: Repositories;
  jev: JevClient;
  thresholds: Thresholds;
  logger: Logger;
  /** 注入便于测试（单测不连 Jev）。 */
  evaluateOutbound: typeof evaluateOutbound;
  /** 测试注入 stub 模型；生产走 configureModelProvider 设的默认 provider。 */
  modelProvider?: ModelProvider;
}
