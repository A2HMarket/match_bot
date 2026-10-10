# P17 — 修复出站工具参数门循环与图文消息丢失（交接给干活的 agent）

> 来源：2026-10-10 线上排查。三条群消息两种静默失败 + 一处环境损坏。
> 本文档只描述问题、证据与建议修法；改完请在下方「完成记录」登记偏差（AGENTS.md §9.1）。

## 背景（仓库当前状态，动手前必读）

- **工作树有大量未提交改动**：P16 有闲市场搜索（另一 agent）+ 小红书搜索源（xhs）+ 出站门取消中间带送审，全部只在工作树，dist 由未提交代码构建。`pnpm check` 当前全绿（61 文件 / 465 用例），但测试没覆盖模型真实输出形状，线上与测试行为不一致。
- `.env` 第 29 行曾被写成 shell 命令替换（`SANDBASE_API_KEY=$(source …)`），已修复为真值；docker compose 恢复可解析。**不要再往 .env 写命令替换。**
- AGENTS.md §3.3 第 10 条已修订：二手 / 租房 / 帮带 / 搭子可经有闲公开 API 只读搜索推荐；招聘仍只打标签。
- 运营现状：群 phase 2；`OUTBOUND_UNSURE_ACTION=drop`；出站门无中间带（过了 `T_WORTH_REPLYING_DROP=1.0` 与 `T_MENTIONS_UNVERIFIED_DROP=0.5` 即 auto，不送审）。

## 问题 A（主 bug）：`reply_with_market_results` 参数校验循环致死，静默丢消息

**症状**：用户发「收 硅胶锅铲/炒菜木铲」（messages.id = `cmv26lif9002p53bgbif2v0c4`，2026-10-10 09:17:56Z），无任何回复。

**链路证据**（decision_traces，input_ref = 上述 message id）：

1. 入站门放行：category=second_hand，`enter_agent`（新授权生效，符合预期）。
2. `market_search` 找到 29 条，`market_enrich` 两批共 8 条（m1/m2/m5/m19/m11/m22/m25/m28）。
3. `reply_with_market_results` **连续 8 次**被 `outbound_input` 门以 `reason=invalid_schema` 拒绝（09:18:12 → 09:18:43）。
4. `MaxTurnsExceededError`（maxTurns=12）→ `agent_failed`，消息静默丢失，用户无感知。

**关键点**：`invalid_schema` 是 `packages/agent/src/tools/make-outbound-tool.ts` 里 `cfg.parameters.safeParse(args)` 失败（zod 层面），不是 `validateSelections` 的业务校验（那是 `invalid_evidence`）。模型的原始参数没有持久化（session_items 里没有失败的 function_call，worker 日志也无 state dump），**失败时具体哪个字段报错此前完全不可见**。

**已做的临时措施**：`make-outbound-tool.ts` 的 `recordInvalidDraft` 现在会把 zod issue 的**字段路径 + 错误码**（不含参数值，PII 安全）写进 trace 的 `output.detail`；`invalid_evidence` 会带上给模型的纠错文案。worker 已重启（pid 30453）。**复现方法**：让同群再发一次「收 硅胶锅铲/炒菜木铲」，然后查：

```sql
SELECT created_at, output FROM decision_traces
WHERE output->>'gate' = 'outbound_input' ORDER BY created_at DESC LIMIT 10;
```

**根因假设（按可能性排序）**：

1. `reply-with-market-results.ts` 的参数 schema 对 deepseek-flash 太苛刻（evidence/facts 要求原文逐字引用且有 min/max 长度，name 必须是原文子串），模型反复写不对某个字段（重点怀疑 `evidence`/`facts[].quote` 超长、`group` 超 30 字、或 `facts` 结构不符）。拿到 detail 后对症下药：放宽约束、改写 describe、或把引用校验从 schema 层移到业务层。
2. `errorFunction` 的纠错反馈没有效引导模型收敛（8 次同类失败）。检查 `schemaFeedback`（WeakMap 按 ctx 存）在 SDK 的 needsApproval 与 errorFunction 两个回调里拿到的是否同一个 context 对象。

**无论根因，建议一并加的兜底**：同一工具连续 deny N 次（如 3 次）后，errorFunction 返回终止性指令（让模型 `do_nothing`），避免烧光 maxTurns 后 `agent_failed` 静默丢消息；`agent_failed` 至少要在 worker 日志里保持 error 级（现为 error，OK），并可考虑给用户发一句「没搞定」类提示（产品决定）。

## 问题 B：带图消息整条被丢弃

**症状**：用户发「出 s 码全新衣服」+ 9 张图（2026-10-10 17:17），无任何处理，messages 表无记录。

**原因**：`packages/channel-telegram/src/inbound.ts:27` 要求 `typeof m.text === 'string'`，图片消息的文字在 `m.caption`，直接 return。

**建议修法**：规范化时以 `m.text ?? m.caption` 兜底（caption 同样过现有文本管线；图片本身第一阶段不处理）。注意同步改 `inbound.ts:17` 的 @bot 匹配逻辑（它也只扫 `m.text` 的 entities；caption 的实体在 `m.caption_entities`）。补一条带 caption 的真实 Update 样本测试（AGENTS.md §7 channel-telegram 行）。

## 问题 C（次发）：`reply_with_xhs_notes` 也被 `outbound_input` 拦（`invalid_evidence`）

「伦敦10月有哪些活动」（2026-10-10 09:29:59Z）被拦 2 次后模型自我纠正，第 7 轮发出——这次侥幸成功，但同类重试同样会烧 maxTurns（12）。修问题 A 时把 xhs 工具的引用校验一并检查：`packages/agent/src/xhs-evidence.ts`（未提交新文件）的校验规则是否同样对模型过苛。

## 交接时的环境备忘

- worker 当前 pid 30453（含问题 A 的诊断留痕）；bot pid 11875。改动代码后：`pnpm build && launchctl kickstart -k gui/$UID/com.matchbot.worker`（bot 只入队/发送，一般不用动）。
- Postgres/Redis：`docker compose up -d postgres`（Redis 用 Homebrew 的 6379，不起 compose 的 redis，见 deploy/local/README.md 注意 3）。
- 诊断查询入口：`docker exec match_bot-postgres-1 psql -U matchbot -d matchbot`。
- 环境变量加载：`set -a && . ./.env && set +a`；不要打印任何 key。
- 另有一个 2026-09-22 遗留的游离 worker 进程（pid 81485，不受 launchd 管理）仍连着同一队列，建议 `kill 81485`。

## 完成记录

### 2026-10-10 Codex 修复（Agent 0.10.1）

- 原计划：复现历史 `invalid_schema` 再定位；历史失败没有原始参数，不能倒推具体字段。第一次原查询真实 Phase 0 预览 12.3 秒成功，但复现到 `invalid_evidence`，同一个 SDK call 被 needsApproval/execute 各记一次。后续预览复现了发布日期被当描述内事实、引用不精确、正文写价格和只回报首个错误导致的连续修补。
- 实际：保留原 schema 和来源校验，给模型显式字段长度/事实用途说明；市场证据校验一次反馈所有失败字段，明确原帖发布日期由代码追加，事实里的 date 只用于描述中实际活动/交接日期；没有放宽来源证据，也没有把无法证明的内容自动发出。
- 共用出站工具对同一次 SDK 调用只计一次失败；同一工具连续三次 schema/证据失败后标记本轮拒绝、写 `outbound_retry/input_retry_limit` 并直接结束 SDK 循环。有效草稿清零，允许模型在上限内修正；未新增群内失败提示或其他出站路径。
- 图文修复：`text ?? caption`；按文字来源读取 entities/caption_entities，支持 @mention/text_mention。媒体相册只处理带说明文字的那条消息；图片本身不理解、不下载、不新增存储字段，仍走原文字保留期。
- 用户可见平台名统一 A2H：详情链接、免责声明、生成指令；市场最终正文还会规范历史品牌写法。活动/展览多帖证据校验继续保留，同样共享失败重试上限。
- 回归：补了图文说明文字/两种 caption mention、SDK 参数长度修正、schema/证据失败三次终止、同一调用留痕去重、多字段一次反馈、A2H 品牌输出；`pnpm check` 全通过（61 文件 / 472 测试），92 条 fixture 入站回放 precision/recall/silenceCorrect=1，categoryAccuracy=0.9891（既有 s39 分类分歧保留）。
- 真实验收：`收 硅胶锅铲/炒菜木铲`，3 次搜索、23 候选、4 个详情查询，19.5 秒完成，两次修正后产出 1 条 dry-run 正文，5 条分类推荐，均有 A2H/原帖链接。证据 `/tmp/p17-market-final.json`；无生产数据写入或 Telegram 测试发送。此前只加重试上限的预览产生 0 条拟发，未作为通过证据。
- 运行清理：验证 pid 81485 的启动时间/命令/cwd 属于本仓库，待审及三个队列均为零后 SIGTERM 停止 9 月遗留 worker；仅保留 launchd 管理的服务。`.env` 未改动。
- 本地部署：`pnpm build` 成功，launchd worker pid 37865、bot pid 37878 均 running，2026-10-10 18:12 +08 启动；dist 的 AGENT_VERSION=0.10.1，两份 stderr 新增字节均为 0，进程清单只余这两个托管进程。未提交 main，既有未提交工作全部保留。


### 主干交付（2026-10-10）

用户授权将这几轮已在本地部署的改动一并提交并合并到 main。采用 codex/search-recommendations-p17 分支提交后快进合并，保留既有工作；不直接在 main 创建提交。跨包改动覆盖 shared/websearch/agent/channel-telegram/approval/gating/jev/eval/worker 的搜索、推荐呈现、审批正文及入站契约，没有新增依赖、数据库字段或交易能力。验证：472 测试通过；92 条入站 fixture 回放 precision/recall/silenceCorrect=1，既有 s39 分类分歧保留。
