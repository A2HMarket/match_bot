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
// recommendation 的 text 支持编号标题与来源链接行；Telegram 按 P14 文末契约转换为 bold / text_link 实体（2026-10-10）。
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
interface MatchContext { userId: string; chatId: string; groupId: string | null; phase: Phase; sourceMessageId: string; source?: { messageId: string; userId: string }; rateLimitPerDay?: number /* 缺省 = 不限 */; demandId?: string; demand?: DemandDraft; recentReplies: string[]; addressedToBot?: boolean; replyToBotText?: string; supplierSearchEmpty?: boolean; outboundBlocked?: boolean; searchResults?: SearchCandidate[] }  // source 为渠道侧 id，用于回帖 @ 作者与私聊目标；outboundBlocked：出站门拒过一次后本轮不再出站
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

### P14 小红书推荐呈现契约（2026-10-10）

- `reply_with_xhs_notes` 参数从 `{ intro, refs }` 改为 `{ intro, recommendations: [{ ref, name, reason, evidence }] }`。1–3 项，按相关性排序；`name` 必须来自候选标题/正文，`evidence` 必须逐字来自返回的正文节选，ref 不重复。链接只能取候选的原始 URL。
- 出站 `recommendation.text`：空行分项，标题行 `1. <name>`；来源行 `来源：[小红书原文](https://www.xiaohongshu.com/explore/<id>?...) · <author>`，英文对应 `Source: [Xiaohongshu note](...)`。其他行作为普通文本。
- channel-telegram 只对 recommendation 识别编号标题与以上来源行，转换成 Telegram `bold` / `text_link` entities；不设置 parse_mode。原始 URL 的 xsec_token 保留在链接目标，正文只显示标签。加提及后按 UTF-16 重新计算偏移。
- 审批恢复从服务端加密快照还原 xhsNotes、原消息定位与频控上限；校验 run 身份及所有字段。开放需求优先用数据库的最新记录。
- 改动涉及 agent + channel-telegram 的文本契约；未新增出站工具、SDK、依赖或个人数据字段。


### P14 多轮研究与实体推荐契约（2026-10-10，0.9.0本机已启用）

- `XhsSearch.find({ keyword, page?: 1|2, limit?: number, excludeUrls?: string[] })`，每次最多 10 条，正文上限 2000 字；笔记 URL 去重键忽略 token，避免重取详情。
- `xhs_search({ purpose: "discover"|"enrich", queries: [{keyword,page,entity:string|null}] })`；每批 1–3 查询，每轮最多 8 个不同查询/40 篇唯一笔记。发现阶段最多 4 查询，其余留给实体补搜；enrich 的 entity 必须出自已召回正文/标题且包含在关键词中。去重、缓存空结果、固定搜索总预算，模型不得越过出站拒绝重试。
- `MatchContext.xhsQueries` 保存已消耗查询；xhsNotes 编号在 run 内稳定且跨批累积。批工具返回新增笔记的原文段落、预算与总量。段落按真实/转义/Unicode换行切分，单段最多300字符；编号从持久化正文确定性派生，审批快照恢复两者。
- `reply_with_xhs_notes` 转为实体条目：`{intro,recommendations:[{name,aliases,group,summary,reason,sources:[{ref,passages:string[]}],facts:[{label,status,passages:string[]}]}]}`。最多 6 项；同展合并，多帖引用，同帖可支持多个展。xhs_search 返回代码切出的原文段落及稳定编号（xN:pM），模型只选择编号，不复制引文；facts/name/aliases 保持原文校验，已知fact必须选择已引用笔记中的一个原文段落，文本由代码取出、仅去掉展示前缀；不再让模型复制value。未知passages=[]；冲突至少选两篇不同笔记的不同段落。名称只忽略大小写/空白/标点，不翻译、不补词、不跨行拼接，年份仍需匹配。
- 标题 `1. <name>`，分类 `【<group>】`；来源行可有多个 `[小红书原文 N](url)`。链接与标题由代码生成，发送仍只写 outbound 表，经原 needsApproval 门。

- 请求共享串行限速（350ms 间隔，429 Retry-After 退避上限 5s），每个查询总上限 30s，两次尝试后停止；候选详情先按笔记 ID/URL 去重。翻页保留同关键词与筛选条件的 search_id/search_session_id（15min 内存寿命）。
- 当前 0.9.0 对 deepseek-flash 显式传 `providerData.thinking.type=disabled`（SDK ChatCompletions 透传），其他模型不传；非思考模式已在A2H真实生成中通过；XHS证据编号协议单独做完整预览验证。仍由 Jev 出站门判断是否发。


### P16 A2H公开搜索契约（2026-10-10，实施中）

- `createMarketSearch({logger,fetchImpl?}): MarketSearch` 仅 GET 固定 https://a2hmarket.ai/a2h-post/api/v1/public/listings 与 /{id}，无需 cookie/key。`find({keyword,page,tradeType})` 返回 items + hasNext + total + notice（可为空的服务端退让/不完整提示），`detail(id)` 返回同条 listing 的详情。
- `MarketListing` 只含公开 id/title/已脱敏 description/tags/tradeType/status、帖子级 priceDisplay、可用时间与原帖时间、构造的A2H详情 URL 与校验后来源 URL。用户 ID、联系方式、昵称不进入候选。
- `MarketIntent = second_hand | housing | carry | companion`；MatchContext 保存市场候选、查询/详情预算及 intent，服务端加密快照保留 7 天，不新增 DB 个人字段。
- `market_search({plan?,intent,purpose,queries:[{keyword,page,tradeType}]})`：每批至多 3、每 run 8 个不同查询/160 个候选，每页20条均入池；8次均可发现/补搜；去重 id、未知/空/失败也消耗预算。仅 London 有文本证据的活跃候选参与推荐；币种/时区不当作伦敦证据。
- `market_enrich({refs})`：每批至多 4、每 run 至多 8 个候选详情；只认已返回的 ref。同一卖家/房源的字段保持归属，不按物品名合并不同贴主。
- `reply_with_market_results({intro,recommendations:[{ref,name,group,summary,reason,evidence,facts:[{label,value,quote}]}]})`：至多 6 项，facts 引用该 listing 原句；价格/日期/买卖方向由候选字段生成，允许未标价但不能宣称满足预算；转载帖附原始小红书链接并引导原帖确认。
- 入站继续使用 is_local_request：新增主动求二手/房源/帮带/搭子，允许 category=other/housing/second_hand 进入搜索；job 与敏感请求仍不进。is_demand 校准题措辞不变。与 XHS/Tavily 每 run 一个来源，出站仍过原审批/频控/阶段门。

- 真实 API 当前存在 `SELL / BUY / PEER`（搭伴）三种帖方向；ANY 是客户端不传筛选的查询选项。当前用户输入在 `runInbound` 经纯规则 `selectMarketTradeType` 选择对家方向，市场工具执行该方向而不是照抄模型误选，并返回 effectiveTradeType。方向与查询一起进快照，记录独立 gate trace。
- 可用期既可为带时区的 ISO 时间戳，也可为 YYYY-MM-DD；日历日期按伦敦当天含截止日解释。原文独立“已出/已售/已租”等结束标记会拒绝，不能只信过期的 ON_SALE 导入状态。
- 查询结果显式区分 ok/empty/partial/unavailable；API 失败不能解释成全平台无匹配。
- `XHS_RESEARCH_ENABLED` 默认 false：发布只启用A2H新研究；XHS 保留 0.6.0 已验证工具参数协议。新多轮 XHS 代码/测试仍保留，待真实综合通过后才能开关启用，不能因新来源发布而自动启用。

- 0.9.0本机已启用XHS_RESEARCH_ENABLED=true；新环境默认false仍保留显式启用策略。真实Phase0完整预览77.8s，6查询/40篇→6实体，2次综合，1草稿；最终段落换行修复以同批40篇缓存复核通过40.3s。出站仍走原阶段/Jev/频控门。SDK脱敏时，schema错误只保留字段路径/约束反馈给模型，不保存无效参数或新增个人数据。

### P14 Sandbase 小红书传输契约（2026-10-10）

- 小红书客户端替换为Sandbase，工厂/领域候选保持`createXhsSearch`/`XhsSearch`/`XhsNote`。Worker仅由Env.SANDBASE_API_KEY注册此来源，不再使用TIKHUB_API_KEY；模型工具参数、研究预算、快照和出站路径不变。
- `POST https://api.sandbase.ai/v1/api/xiaohongshu/app-v2/search-notes`，JSON keyword/page整数/note_type/sort_type/time_filter及翻页search_id/search_session_id，Bearer鉴权；详情POST同前缀image-note-detail，仅传note_id。
- 同步返回必须status=completed，读取outputs[0].data再校验success=true；搜索items在payload.data，翻页ID在payload外层；详情payload.data是含note_list的数组，必须匹配请求ID。广告/其他卡片跳过，详情失败退回搜索正文；原文链接继续保留搜索返回的xsec_token。
- 仍为每查询30s、每请求最多10s、最多两次尝试和共享350ms限速；401/403等确定性4xx直接结束，429可退避；不打印响应错误正文、鉴权头或key。
- 官方参考：https://blog.sandbase.ai/xiaohongshu-note-research-api/ 。PoC实际核对搜索/详情/翻页，未依赖生成示例中的占位prompt。环境变量只由shared.loadEnv读，本机当前使用权限600、git忽略的.env注入已有SANDBASE_API_KEY；.env必须是可供shell与docker compose读取的字面值配置，禁止写source或命令替换表达式。密钥不进入代码、日志或提交。

### P14 单源退化修复与选择性全文（0.10.0）

- Sandbase XhsSearch.find新增includeDetails?；默认true保留单次旧协议，新研究在readNote端口可用时设false，先只召回卡片。readNote(note)仅从已返回小红书URL取ID，读取匹配ID详情，返回同ref/url并标记isDetailLoaded=true。
- 模型新增只读xhs_read_notes({refs:string[]})，每批1-6、每run最多12个不同全文尝试，失败缓存占预算；共享限速与每次HTTP10s不变，全文批次总30s。ctx.xhsDetailRefs与候选isDetailLoaded在服务端加密审批快照中恢复；不是新增个人数据字段。
- xhs_search按查询独立校验：合法查询继续，不因同批无效/未知实体丢弃；返回被拒index与原因。公开活动名的+允许，电话号码/账号/邮箱/完整邮编守卫保留。
- 最终回复拒绝未读卡片；有两份以上不同全文介绍同一实体时要求合并至少两份。复制正文不算补充资料；同展需保持场馆/日期/届次一致。单源明确标记，正常多源标记综合N篇；max6条目/4来源及3700字符草稿约束不变。泛需求优先3-4个充分描述、多主题的选项，不能为了凑6条缩减成每项单源。

- 多来源正式名关联：主名称/别名仍需在至少一份引用中完整出现；对“艺术家:展名”的其他来源，两部分在同一篇正文中分别出现也能关联，只出现艺术家仍拒绝。
- 泛需求（至少2条发现query）在全文额度未耗尽时要求至少半数、最低2项多源；额度耗尽也不许多源主选项被多数单源填充，应减小选项数并重写intro。完全无多源时允许最多3个明确单源的有限资料结果，不制造第二来源。全文预算耗尽后停止新增搜索。

- 保留ctx.xhsValidatedRecommendations（max6，本轮通过引用校验的条目，沿用server snapshot 7天加密过期），来源更充分的版本不被后续改写覆盖。证据足够或额度耗尽时由代码优先多源主项并限制单源补充；生成与选择一致的intro。缺失/不合格实用字段在额度末尾标为unknown，不展示错误值；主名称/来源/未读卡片仍不允许伪造，未证实的可选别名移除。
- 审批保存最终编译正文outboundPreviews（SDK callId关联），interruptions新增可选draftText，approval优先展示实际拟发文案；恢复后发送审批过的同一正文，旧快照回退兼容原args。未新增出站路径或个人数据类型，沿用现有消息/snapshot保存与过期规则。

- 全文批次超过剩余额度时执行可用部分，budgetLimitedRefs明确未执行的编号，不能因一份额度不足拖掉整批。XHS最终出站成功/门拒绝后由toolUseBehavior直接完成，未通过证据/参数校验仍继续模型修正，SDK审批仍能中断。

### P17 出站修正与媒体说明文字契约（0.10.1）

- 出站参数校验保持原 schema；给模型反馈字段路径/约束，trace 只记录字段路径、错误码和不含参数值的纠错信息。市场校验一次返回所有失败字段，区分原帖发布日期与描述里的活动/交接日期。
- 同一 SDK callId 的失败只记一次；同一出站工具连续三次参数/证据失败后写 outbound_retry/input_retry_limit，拒绝本轮后续出站并结束运行。有效草稿清零；Phase 0/1/2 与 Jev 不可用降级不变。
- Telegram 入站文字取 text ?? caption，按来源读取 entities/caption_entities；无文字的媒体继续忽略，不读取或新增持久化图片字段。
- 平台用户可见名称统一 A2H；推荐仍仅由原出站表与渠道发送路径执行。

### P18 自适应 A2H 搜索补充（2026-10-11，Agent 0.12.0）

- 首次 plan 分开 needs/terms、preferences、requiredTerms/excludeTerms/requiredArea、budget、route、dateRange。只有用户明说的条件保留；技能/租期等不作为独立供给主体。后续只接受源内出现的别名，保留主体与原约束。
- 后验检查返回 met/mismatch/unknown，价格按选择的单品行绑定，地区/路线按供给文本归属；明确冲突拒绝。已有同需求且地区/路线确认的候选时，优先这些候选再考虑未知线索。
- 模型显示最多16个排序视图，额外连续 evidencePassages 暴露长帖后半部主体；候选编号保持稳定，加密快照保留规范后的 plan。
- 使用 plan 时，最终描述只渲染 exact evidence 引文，适配/地点/路线/报价依据由代码计算。模型自由 summary/reason/facts 不出站、不进入评估摘要；旧无 plan 协议仍严格校验全部字段。
- 公共 notice 为不可信源元数据，规范后给模型看，不能当成满足用户全部条件的证明。原文优先于转载活动摘要；明确非新手/中阶以上活动不推荐给初学者。
- 搜索参数错误返回字段反馈，三次失败停止；市场来源推荐成功写出站表后立即结束 run，不额外生成第二份回复。阶段、Jev、频控和出站表不变；无新数据库或个人数据字段。

### P19 A2H选择建议补充（0.13.0）

- 规范后的marketPlan可含essentialPreferences；由原请求区分关键要求与“最好/希望”偏好，沿用加密快照7天保留；不增加模型输入schema必填字段或数据库字段。
- market_search/market_enrich返回choiceHints（首选/备选refs与关键缺口）和researchTasks（先详情、再源内实体名+缺口补搜）。既有8查询/8详情上界不变；已尝试enrich、无预算或无可执行任务时不反复强制补搜。
- 带plan的reply_with_market_results最多3首选+2备选，无首选时最多3备选；确定冲突仍拒绝，未知候选可以和已确认候选分别展示，但不能用未知候选替代已有确认候选。适配/已知风险/同档单品报价排序、同原帖同物品去重，由代码执行并写trace；不同物品/贴主不合并。
- 精确原句、单品价、原帖日期与链接保持事实归属；评分/原文提及不等于真实库存、机器功能或入住/航班可用保证。原门、频控与出站表不变。


### P20 agent 内部出站反馈与评估（0.13.1）

`DraftResult` 的错误分支增加可选 `kind: 'research_required'`。它表示正常的缺口补搜，单独记 `outbound_research` trace，不计入 `outboundInputFailures`；真正 schema/证据错误仍累计三次后终止。

`OutboundDraftInput.evaluationDemand?: DemandDraft` 只由工具内部构造，不开放给模型参数。A2H 推荐使用本轮受原请求约束的 `MarketPlan`（当前品类、分项需求、路线、区域、日期、预算）；没指定的字段不从历史建档继承。旧工具仍默认使用 ctx.demand。该字段不写出站表，不新增 DB/PII 字段；phase、Jev、频控及审批契约不变。


P20真实Telegram补充（0.13.2）：第三次证据纠错时，若部分条目独立合格，则移除不合格条目并对有效子集重新运行全部校验；正常补搜/phase/Jev/频控不变。全无效、schema及公开联系方式错误仍拒绝。market_recommendation_selection增加rejectedRefs，无文本或身份值。


### P22 回答与查证契约

MatchContext增加currentRequest（原输入及本轮评估DemandDraft）、knowledgeSources（公开来源和段落ID）、informationQueries/sourceFailures、answerRecorded。所有出站优先用currentRequest评估，旧开放需求只作接话背景。WebSearch增加可选research(query,domains)返回公开证据，不按商家联系人过滤；XhsSearch增加显式不可用错误，Agent可走官网信息补充。新增reply_to_request为出站tool，复用原needsApproval/gate/出站表，不直接发送。Telegram仅格式化代码生成来源行的https链接，不执行正文Markdown。原API find兼容保留；不新增DB字段/私信/交易路径。


P22兼容与终点：AgentDeps.answerRequests由worker启用，旧注入调用保留原工具行为。新record_request从绑定的本轮需求建内部Demand，不复用其他独立请求的Demand ID。独立请求仍保留用户级session存储，但模型输入排除旧题；明确引用的公开bot回复作为待核实数据注入。现代输入失败达到上界标answerInputExhausted，由受限终点产生代码固定的失败说明，仍走原needsApproval/phase/Jev/频控；真实outboundBlocked永不清除。模糊租金下限/估计标unknown，精确机场出门时刻须由所引官方时刻表支持。


### P23 拒绝后的受控请求状态

Jev出站输入以source_evidence表达供应商、A2H与公开信息来源，replyPurpose区分answer/request_status；旧调用参数supplierSummaries兼容。问题集判定不可靠事实与适配保证，允许明确未知和实用解释。gating增加isVerifiedRequestStatus，仅agent确认notification文本精确等于服务器renderRequestStatus且当前请求可行动、未回复时才为true。代码固定状态可忽略推荐语义分，Jev不可用/phase/频控策略不变，所有分数及状态门留痕。ctx.outboundBlocked不清除，原推荐仍终止；status工具不接收模型文案。未送审阶段由controller调用tool.needsApproval和tool.invoke，不再调用生成模型写失败说明；需审批时保留SDK加密快照/原子恢复路径，isRequestStatusRun随服务端快照恢复。无新DB或PII字段。


### P24 任务领域基础（实施中）

新增domain taskSchema/UserTask（用户、作用域、版本、目标/验收条目、约束来源、证据、待回答问题、投递与用户确认）及assessTaskReadiness、transitionTaskStatus。readiness只代表有据的信息交付，不代表真实生活目标达成；completed/cancelled需受信入站构建的owner用户确认及sourceMessageId，模型工具不能选择actor身份或意图。queued/sent/用户完成分开，已发问题才waiting_user；同目标证据绑定、未知/冲突不作supported。新任务契约独立于旧Demand兼容，尚未接入worker/SDK/出站，不改变当前线上行为。DB接口、迁移与任务关联随后在本节补充；旧数据不猜测归属。

P24基础接口（分支验证中）：

- `selectTask`先过滤owner/channel/chat及终态；新意图、明确引用、唯一接话、歧义及无可关联目标分别返回结果。不按最近任务盲接，语义意图由调用方判定，尚未实现入站自动路由。
- `reviseTaskRequirements`只合并指定goal/constraint，不能传入证据状态或用户完成状态；每项变更必须引用当前用户消息中存在的原句，origin由服务端写入。原句存在只证明出处，不自动证明模型解释正确，P25真实多轮仍须评判。条件改变递增requirementsVersion并作废旧适配证据，其他分项条件保留。
- `confirmTaskGoal`与整个任务完成分开；本人明确确认一件已买到，不关闭其他子目标，不伪造其来源已核实。`revision`记录操作，`requirementsVersion`仅记录条件变化，不能混作出站授权版本。
- `repos.tasks.{create,findById,findOpenByScope,reviseRequirements,confirmGoal,transition}`均需要受信`access={userId,scope:{channel,chatId}}`。写入带expectedRevision/operationKey，返回applied/replayed/conflict/not_found；相同幂等键不同载荷报错。Task头及事件checkpoint为一个Prisma嵌套写入。sourceMessageId必须归本人及同作用域；不得让模型选择access/actor或传整份状态覆盖。
- 新迁移`20261016170253_task_foundation`只加tasks/task_events及TaskStatus，不改旧业务表语义。Task.state经domain taskPayloadSchema校验，只存可变部分；身份/作用域/版本以列为准。30天无用户活动后deleteInactiveBefore删除task及级联事件，由worker的delete_inactive_tasks清理任务执行；不因agent运行刷新保留期。
- `MatchContext.task`仅接收服务端选中并更新后的任务，`channel`用于scope检查。`bindCurrentRequest`能将其未解决目标、当前条件和简短补充绑定成评估输入，排除已完成分项及内部ID；SDK stub已验证能进入模型instructions。worker尚未加载task，真实语义路由、追问送达绑定、证据落账及快照版本核对仍属P25/P26，不能宣称线上接话已修复。
