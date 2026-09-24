# 跨包接口契约

> 所有工作包以本文件为准。改签名先改这里。类型省略 import；`Prisma` 类型来自 `@matchbot/db` 的 generated client。

## @matchbot/shared

```ts
loadEnv(source?: Record<string, string | undefined>): Env          // 已有
createLogger(name: string, level?: string): Logger                  // 已有，redact text/phone
normalizePostcode(raw: string): { full: string; outward: string } | null   // 已有
hashText(text: string): string                                      // P1：sha256 hex
```

## @matchbot/domain

```ts
// 已有
inboundMessageSchema / InboundMessage      // { channel, chatId, messageId, userId, text, lang?, replyToMessageId?, addressedToBot?, replyToBotText?, receivedAt }（后两者 P15：回复 bot / @bot / 私聊为 addressed；replyToBotText 是被回复的 bot 消息原文）
DEMAND_CATEGORIES / DemandCategory / SERVICE_CATEGORIES
DEMAND_STATUSES / DemandStatus / canTransition / transition / IllegalTransitionError
PHASES / Phase

// P1 新增
isServiceCategory(c: DemandCategory): boolean
demandDraftSchema / DemandDraft   // { category, whenText?, whenAt?(ISO), fromPostcode?, toPostcode?, quantity?, budgetPence?, lang?, confidence }
supplyDraftSchema / SupplyDraft   // { category, availability?, area?, expiresAt(ISO) }
outboundDraftSchema / OutboundDraft // { channel, target, text, toolCallId?, kind?, replyToMessageId?, mentionUserId? }（kind ∈ OUTBOUND_KINDS（含 reaction：text 为 emoji，replyToMessageId 为被加表情的消息），缺省 recommendation；后两者为渠道侧 id，2026-09-23 加）
TRACE_KINDS / TraceKind           // 'rule' | 'jev' | 'agent_run' | 'gate'
decisionTraceInputSchema / DecisionTraceInput // { kind, inputRef, output: unknown, phase, latencyMs, costMicro? }
INBOUND_QUESTION_IDS = ['is_demand','is_supply','category','urgency','has_location','is_sensitive','is_move_event'] as const
OUTBOUND_QUESTION_IDS = ['worth_replying','language_ok','mentions_unverified'] as const
```

## @matchbot/db

```ts
getPrisma(connectionString): PrismaClient        // 已有
createRepositories(prisma: PrismaClient): Repositories   // P2

interface Repositories {
  users: {
    upsertByExternal(p: { channel: Channel; externalId: string; lang?: string }): Promise<User>;
    findById(id: string): Promise<User | null>;
  };
  groups: {
    findByExternal(channel: Channel, externalId: string): Promise<Group | null>;
    upsert(p: { channel: Channel; externalId: string; name: string }): Promise<Group>;
  };
  messages: {
    findExisting(p: { groupId: string | null; userId: string; externalId: string }): Promise<Message | null>;   // 队列重投去重；私聊按 userId 查（NULL 不触发 unique）
    create(p: { groupId: string | null; userId: string; externalId: string; text: string; lang?: string; receivedAt: Date }): Promise<Message>;
    recentByUser(userId: string, sinceHours: number): Promise<Message[]>;
    redactOlderThan(days: number): Promise<number>;             // 置空 text，返回条数
  };
  demands: {
    findOpenByUser(userId: string): Promise<Demand[]>;
    create(p: DemandDraft & { userId: string; sourceMessageId: string; isMoveEvent?: boolean }): Promise<Demand>;
    update(id: string, patch: Partial<DemandDraft> & { sourceMessageId?: string }): Promise<Demand>;
    setStatus(id: string, status: DemandStatus): Promise<Demand>;   // 内部用 domain.transition 校验
    expireOlderThan(days: number): Promise<number>;
  };
  supplies: {
    create(p: SupplyDraft & { userId: string; groupId: string; sourceMessageId: string }): Promise<Supply>;
    findActive(category: DemandCategory): Promise<Supply[]>;
  };
  suppliers: {
    findCandidates(p: { category: DemandCategory; pool?: 'A' | 'B' }): Promise<Supplier[]>;
    findByIds(ids: string[]): Promise<Supplier[]>;
  };
  matches: {
    replaceForDemand(demandId: string, rows: Array<{ supplierId?: string; supplyId?: string; matcherScore: number; jevFit?: number; rank: number }>): Promise<Match[]>;
  };
  leads: {
    create(p: { matchId: string; sentVia: Channel; sentAt: Date }): Promise<Lead>;
    update(id: string, patch: { supplierResponse?: string; isConverted?: boolean; isPaid?: boolean; followedUpAt?: Date }): Promise<Lead>;
  };
  sessionItems: {
    list(userId: string, limit?: number): Promise<unknown[]>;      // 按 seq 升序返回 item
    append(userId: string, items: unknown[], operationId?: string): Promise<void>;   // operationId 重复则 no-op
    popLast(userId: string): Promise<unknown | null>;
    clear(userId: string): Promise<void>;
  };
  runStates: {
    create(p: { userId: string; chatId: string; phase: Phase; snapshot: string; agentVersion: string; sdkVersion: string; interruptions: unknown; expiresAt: Date }): Promise<RunState>;
    findById(id: string): Promise<RunState | null>;
    consume(id: string): Promise<RunState | null>;   // 原子：UPDATE ... WHERE status='pending'；0 行返回 null
    expireOld(now: Date): Promise<number>;
  };   // schema 需加 chat_id、phase 两列（P2 迁移里一起做）
  approvals: {
    create(p: { runStateId: string; reviewer: string; decision: 'approve' | 'reject' | 'edit' | 'ignore'; editedText?: string }): Promise<Approval>;
    findById(id: string): Promise<Approval | null>;
  };
  outbound: {
    create(draft: OutboundDraft, status: OutboundStatus): Promise<OutboundMessage>;
    claimPending(limit: number): Promise<OutboundMessage[]>;       // 取 pending 并不改状态；发送方 markSent/markFailed
    markSent(id: string): Promise<void>;
    markFailed(id: string, error: string): Promise<void>;
    countSentToTargetSince(target: string, since: Date, kind?: OutboundKind): Promise<number>; // 频控传 'recommendation'
  };
  traces: {
    create(input: DecisionTraceInput): Promise<DecisionTrace>;
    listByKind(kind: TraceKind, since: Date, limit?: number): Promise<DecisionTrace[]>;
  };
}
```

## @matchbot/queue

```ts
QUEUE_NAMES                                  // 已有
inboundJobSchema / resumeRunJobSchema / outboundJobSchema   // 已有
inboundJobId(channel, chatId, messageId)     // 已有
createQueues(redisUrl: string): Queues       // P3：{ inbound, resume, outbound, cron } 均为 bullmq Queue
enqueueInbound(q: Queues, msg: InboundMessage): Promise<void>      // jobId = inboundJobId
enqueueResume(q: Queues, p: { runStateId: string; approvalId: string }): Promise<void>
enqueueOutbound(q: Queues, outboundMessageId: string): Promise<void>
createWorker<T>(name: QueueName, redisUrl: string, handler: (data: T, jobName: string) => Promise<void>, opts?: { concurrency?: number }): Worker   // cron 队列靠 jobName 分派
closeQueues(q: Queues): Promise<void>
```

## @matchbot/jev

```ts
createJevClient(p: { baseUrl: string; apiKey: string; model: string; traces: Repositories['traces']; logger: Logger; fetchImpl?: typeof fetch; timeoutMs?: number }): JevClient

interface JevClient {
  evaluate<Q extends string>(p: { state: unknown; questions: Record<Q, JevQuestion>; inputRef: string; phase: Phase }): Promise<JevOutcome<Q>>;
}
type JevOutcome<Q extends string> =
  | { ok: true; answers: Record<Q, JevAnswer>; usage: { input_tokens: number } }
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' };

// 问题集与解读
inboundQuestions(): Record<InboundQuestionId, JevQuestion>
evaluateInbound(client: JevClient, p: { text: string; groupName: string; lang?: string; recentTexts: string[]; inputRef: string; phase: Phase }): Promise<InboundVerdict | { ok: false; reason: string }>
interface InboundVerdict {
  ok: true;
  isDemand: number; isSupply: number; category: DemandCategory; categoryConfidence: number;
  urgency: number;   // score 0–4 的概率加权均值
  hasLocation: number; isSensitive: number; isMoveEvent: number;
  isLocalRequest: number;   // P14：在找本地商家/店铺/地方，只在 category=other 上使用
}
outboundQuestions(): Record<OutboundQuestionId, JevQuestion>
evaluateOutbound(client: JevClient, p: { draft: string; demand: DemandDraft; supplierSummaries: string[]; recentReplies: string[]; inputRef: string; phase: Phase }): Promise<OutboundVerdict | { ok: false; reason: string }>
interface OutboundVerdict { ok: true; worthReplying: number; languageOk: number; mentionsUnverified: number }
```

## @matchbot/gating

```ts
DEFAULT_THRESHOLDS: Thresholds
interface Thresholds {
  T_IS_DEMAND_ENTER: number;      // 0.7
  T_IS_SUPPLY_ENTER: number;      // 0.7
  T_IS_SENSITIVE_DROP: number;    // 0.5
  T_IS_MOVE_EVENT_TAG: number;    // 0.6
  T_IS_LOCAL_REQUEST_ENTER: number; // 0.8（P14 校准）
  T_WORTH_REPLYING_AUTO: number;  // 2.2（score 0–3）
  T_LANGUAGE_OK_AUTO: number;     // 0.8
  T_MENTIONS_UNVERIFIED_DROP: number; // 0.5
  T_WORTH_REPLYING_DROP: number;  // 1.0
}
resolvePhase(p: { group: Group | null; defaultPhase: Phase }): Phase
decideInbound(v: InboundVerdict, t: Thresholds, opts?: { addressedToBot?: boolean }): InboundDecision   // addressed 且不敏感 → enter_agent kind='followup'
type InboundDecision =
  | { action: 'drop'; reason: 'sensitive' | 'not_demand' }
  | { action: 'tag_move_event' }           // 非服务品类（含 other）且 isMoveEvent 高，仅打标签用于观测
  | { action: 'enter_agent'; category: DemandCategory; kind: 'demand' | 'supply' | 'both' }
decideOutbound(p: { phase: Phase; verdict: OutboundVerdict | null; rateOk: boolean; t: Thresholds; onUnsure?: 'review' | 'drop' }): OutboundDecision  // Phase 2 拿不准时的去向，缺省 review；worker 取 env.OUTBOUND_UNSURE_ACTION（默认 drop）
type OutboundDecision = 'dry_run' | 'review' | 'auto' | 'drop'
createRateLimiter(outbound: Repositories['outbound']): { check(p: { target: string; limitPerDay: number; now: Date }): Promise<boolean> }
isBlacklisted(text: string): boolean     // 换汇 / 虚拟币 / 代付 关键词表
```

## @matchbot/matcher

```ts
scoreSuppliers(p: { demand: DemandDraft; suppliers: Supplier[]; now: Date }): ScoredCandidate[]     // 降序
scorePeerSupplies(p: { demand: DemandDraft; supplies: Supply[]; now: Date }): ScoredCandidate[]
interface ScoredCandidate { id: string; kind: 'supplier' | 'supply'; score: number; reasons: string[] }   // score 0–1
```

## @matchbot/websearch（P14）

```ts
createWebSearch(p: { apiKey: string; logger: Logger; fetchImpl?: typeof fetch; pageTimeoutMs?: number }): WebSearch
interface WebSearch { find(p: { need: string; area?: string }): Promise<SearchCandidate[]> }   // 最多 5 条，已核验
interface SearchCandidate { ref: string; name: string; url: string; contact: { phone?: string; whatsapp?: string; instagram?: string }; evidence: 'contact_on_own_site' | 'instagram_profile' }
buildSearchQuery(p: { need: string; area?: string }): string   // 拒绝像个人信息的输入，抛 UnsafeQueryError（Tavily 会留存查询）
```

## @matchbot/channel-telegram

```ts
toInboundMessage(update: Update, p: { botId: number }): InboundMessage | null      // 非文本、非群/私聊、Bot 自己的消息返回 null
createTelegramSender(p: { bot: Bot; logger: Logger }): { send(m: OutboundMessage): Promise<void> }   // target 为 chat id，出错抛 TelegramSendError
createOpsCardSender(p: { bot: Bot; opsChatId: string }): { sendApprovalCard(card: ApprovalCard): Promise<{ messageId: string }> }
createOpsCardSenderFromToken(p: { token: string; opsChatId: string }): ReturnType<typeof createOpsCardSender>   // 给 apps/worker：只发不收，不 start()，不与 apps/bot 的长轮询冲突
interface ApprovalCard { runStateId: string; title: string; draftText: string; supplierLines: string[]; confidence: number }
parseApprovalCallback(data: string): { runStateId: string; decision: 'approve' | 'reject' | 'ignore' } | null   // callback_data 格式 `apv:<runStateId>:<decision>`
```

## @matchbot/agent

```ts
AGENT_VERSION: string                          // 已有，改 instructions/工具描述时递增
createMatchAgent(deps: AgentDeps): { agent: Agent<MatchContext>; runner: Runner }
interface AgentDeps { env: Env; repos: Repositories; jev: JevClient; thresholds: Thresholds; logger: Logger; evaluateOutbound: typeof evaluateOutbound; webSearch?: WebSearch; modelProvider?: ModelProvider }   // webSearch 缺省则库外工具不注册
interface MatchContext { userId: string; chatId: string; groupId: string | null; phase: Phase; sourceMessageId: string; source?: { messageId: string; userId: string }; rateLimitPerDay?: number; demandId?: string; demand?: DemandDraft; recentReplies: string[]; addressedToBot?: boolean; replyToBotText?: string; supplierSearchEmpty?: boolean; outboundBlocked?: boolean; searchResults?: SearchCandidate[] }  // source 为渠道侧 id，用于回帖 @ 作者与私聊目标；outboundBlocked：出站门拒过一次后本轮不再出站
runInbound(p: { deps: AgentDeps; ctx: MatchContext; input: string }): Promise<RunOutcome>
resumeRun(p: { deps: AgentDeps; runState: RunState; approval: Approval }): Promise<RunOutcome>
type RunOutcome =
  | { kind: 'completed'; toolsCalled: string[] }
  | { kind: 'interrupted'; runStateId: string }
createPgSession(p: { repos: Repositories; userId: string }): Session
```

## @matchbot/approval

```ts
publishApproval(p: { repos: Repositories; cards: ReturnType<typeof createOpsCardSender>; runState: RunState }): Promise<void>
handleApprovalCallback(p: { repos: Repositories; queues: Queues; reviewer: string; data: string }): Promise<'queued' | 'ignored' | 'invalid'>
```
