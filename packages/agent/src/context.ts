import type { Repositories } from '@matchbot/db';
import type { DemandDraft, Phase } from '@matchbot/domain';
import type { Thresholds } from '@matchbot/gating';
import type { evaluateOutbound, JevClient } from '@matchbot/jev';
import type { Env, Logger } from '@matchbot/shared';
import type { SearchCandidate, WebSearch } from '@matchbot/websearch';
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
  /** 该群每天最多推荐几次（groups.rateLimitPerDay）；缺省 = 不限。 */
  rateLimitPerDay?: number;
  /** 用户在对 bot 说话（回复 bot / @bot），以及被回复的那条 bot 消息原文。 */
  addressedToBot?: boolean;
  replyToBotText?: string;
  demandId?: string;
  demand?: DemandDraft;
  recentReplies: string[];
  /** find_suppliers 本次 run 是否查过且为空；web_search 的前置条件之一（P14）。 */
  supplierSearchEmpty?: boolean;
  /**
   * 出站门本轮已拒过一次。之后所有出站工具直接拒绝：出站门决定的是「该不该回」，
   * 不能让模型改写重投、直到分数过关（2026-09-24 实测连投 6 版才过）。
   */
  outboundBlocked?: boolean;
  /** 本次 run 的 web search 候选；reply_with_search_results 只认这里的编号。 */
  searchResults?: SearchCandidate[];
}

export interface AgentDeps {
  env: Env;
  repos: Repositories;
  jev: JevClient;
  thresholds: Thresholds;
  logger: Logger;
  /** 注入便于测试（单测不连 Jev）。 */
  evaluateOutbound: typeof evaluateOutbound;
  /** P14 库外兜底搜索；未配 SEARCH_API_KEY 时为空，相关工具不注册。 */
  webSearch?: WebSearch;
  /** 测试注入 stub 模型；生产走 configureModelProvider 设的默认 provider。 */
  modelProvider?: ModelProvider;
}
