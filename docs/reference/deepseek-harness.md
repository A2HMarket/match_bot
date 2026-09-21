# DeepSeek Harness（dsh）技术摘要

| 项               | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整理日期         | 2026-09-21                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 来源             | https://github.com/deepseek-ai/deepseek-harness （master，`@deepseek-ai/dsh-root@0.1.6-alpha.2`，developer preview，MIT）。已读：README、docs/architecture.md、glossary、subsystems/{core,tools,subagent,workflow,schedule,ptc-runtime,mcp,agent-team,goal,webhook,approval,user-questions,jobs,persistence}、api-gateway、capability-seams、cookbook/adding-an-llm-adapter、user/develop/_、user/guide/{providers,python-sdk,schedule}、packages/bundle/_、packages/llm/llm-deepseek、packages/sdk/*、python/sdk、apps/cli |
| 在本项目中的角色 | 撮合 agent 的**运行时底座**（用户指定）。生成模型 deepseek-flash 走它自带的 `dsh-llm-deepseek` adapter；Jev 作为自写 service / tool 接入（见 §5）                                                                                                                                                                                                                                                                                                                                                                           |
| 运行要求         | Node ^22.19 或 ≥24，pnpm 11；Python SDK 自带 runtime wheel，不需系统 Node                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 1. 一句话定义

dsh 是一个 **"一切皆插件"的 agent harness**，底层是 Cordis 插件框架：模型 adapter、工具注册表、session 日志、agent loop 本身都是插件，都能在 YAML 配置里替换。它没有可 patch 的特权内核；扩展方式是把你的插件挂在旁边。

产品定位是 **coding agent**：默认工具集是 read / write / edit / glob / grep / bash / lsp / terminal / web，默认 persona 是 "You are a coding agent... Your working directory is {{cwd}}"，session 强绑定工作目录。这一点决定了它用于消息驱动撮合服务时的错配，见 §8。

## 2. 运行模型

### 2.1 插件

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'
export const inject = ['tools', 'llm']          // 依赖的服务，框架等它们就绪后才 apply
export const Config = Schema.object({ ... })    // Schemastery，加载时校验并填默认值
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(...)                       // 所有注册都是 effect，插件卸载即回滚
  ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) })
}
```

- 三种形态：函数模块、对象、`class extends Service`（向其他插件提供 `ctx.<key>` 服务时用类形态）。
- 事件三种 dispatch：`emit`（观察）、`serial`（顺序 await）、`waterfall`（必须调 `next()` 放行，可短路返回 Decision）。
- 配置改动触发 HMR 热替换（web profile 默认开；headless / sdk / acp 默认关）。

### 2.2 Profile / Bundle / Patch

一个运行中的 dsh 是按顺序叠加的 YAML 行组成的插件树：

```
bundle 各自的 patch（按 profile 声明顺序） → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch 覆盖
```

patch 按 `id` 整块替换某一行的 config，或 `insert` 新行。`dsh --profile <name> --dump-config` 导出整棵树。

| Profile       | Bundle                                      | 用途                                                                                                                                  |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `web`         | `dsh-base` + `dsh-web-app`                  | 浏览器产品，`http://127.0.0.1:3080`                                                                                                   |
| `headless`    | `dsh-base` + `dsh-headless`                 | `dsh --profile headless "task"`，一次一任务、跑完退出、`--json` 输出事件流                                                            |
| `sdk`         | `dsh-base` + `dsh-sdk-app`                  | stdio 上的 JSON-RPC 服务器，TS / Python SDK 的默认目标                                                                                |
| `sdk-minimal` | 仅 `dsh-sdk-minimal`（**不含** `dsh-base`） | 独立最小树：一个持久 shell 工具 + JSONL 持久化 + 一个 DeepSeek adapter；无 settings / credentials / telemetry / compaction / subagent |
| `acp`         | `dsh-base` + `dsh-acp-app`                  | 标准 ACP v1 stdio 服务器                                                                                                              |

`dsh-base` 提供：模型 adapter、工具、持久化、sandbox 与审批策略、settings、credentials、telemetry、Plugin Manager。

**入口约束**：架构文档明确 "direct in-process plugin mounting ... are not Harness application launchers"，且有脚本拒绝绕过 `dsh` 的 Node 入口。**官方支持的嵌入方式只有一种：自定义 profile + patch 文件 + 你自己的插件包，由 `dsh --profile <name>` 启动。** 不能在自己的 Node 进程里 `import` dsh 手动装配。

### 2.3 Agent 的组成（`packages/core`）

| 包                   | `ctx` key            | 职责                                                                            |
| -------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `core/session`       | `ctx.sessions`       | append-only `SessionEvent` 日志，唯一真相源；模型历史由 `deriveMessages()` 派生 |
| `core/system-prompt` | `ctx.systemPrompt`   | prompt section + tool schema 组装                                               |
| `core/tools`         | `ctx.tools`          | 作用域化工具注册表 + 受守卫的执行流水线                                         |
| `core/agent`         | `ctx.agents`         | `Agent` 接口、注册表、`agent/*` 事件；`create / resume / get / list`            |
| `core/agent-loop`    | `ctx.agentLoop`      | 默认驱动器 `ReactLoopAgent`                                                     |
| `core/scope`         | 无                   | per-agent 作用域原语                                                            |
| `llm/llm`            | `ctx.llm`            | 消息 / 流式词汇表 + adapter seam                                                |
| `webhook/webhook`    | `ctx.webhookRuntime` | 外部投递 → 新建 Session                                                         |

`Agent` 句柄：`{ id, options{provider, model, reasoningEffort, maxTokens}, session, inbox, status: 'idle' | 'running', ctx }`，方法 `send(message, target: 'next-turn' | 'next-step')` / `followup()` / `steer()` / `inject()` / `cancel()` / `whenIdle()`。

**Turn / Step 循环**：

```
turn/start
  认领 inbox → 组装 prompt + tool schema
  agent/pre-step   (waterfall：可改写 / 拒绝输入)
  step/start
  agent/request    (waterfall：可替换 provider / model)
  llm/stream       → assistant/message
  tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
  step/end → 工具要求继续则下一 step
agent/turn-stopping (serial)
turn/end
```

- **Model-visible means logged**：任何进入模型请求的内容必须可从日志重建，有运行时 invariant 断言。
- **作用域**：工具 / prompt section / 监听器要么全局，要么绑定在某个 agent 的 `agent.ctx` 上（扁平两级，不向子 agent 继承）；同名 scoped 工具遮蔽全局；`ctx.tools.restrict({ allow, deny })` 过滤全局集。`CreateAgentOptions.setup(agentCtx, agent)` 是创建窗口。`ctx.agentPresets.mount()` 可把一组插件挂到单个 agent。

### 2.4 持久化

`ctx.sessionPersistence`（`packages/session/session-persistence`）抽象 `create / open / stat / list`，返回 `SessionHandle{ read, append, flush, close }`。shipped 实现 `dsh-session-persistence-jsonl`：`$DSH_HOME/sessions/.../session.vN.jsonl[.zstd]`，单写者租约，崩溃后 resume 自动补 `turn/end`。可自实现其他后端。`ctx.agents.resume({ resumeSessionId })` 恢复；fork 用 `seed` 前缀。`session-query`（SQLite）提供全文 / 语义检索。

## 3. 自定义工具（`@deepseek-ai/dsh-tools`）

```ts
ctx.tools.register(defineTool({
  name: 'classify_demand',
  description: '...',
  parameters: { text: { type: 'string', required: true } },     // string/number/integer/boolean/null/array/object/json/oneOf
  output: { schema: { type: 'object', ... }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  async execute(args, exec /* ToolRunContext: signal, deferContext(), concludeTurn() */) { return value },
  timeoutMs?, isConcurrencySafe?(args), finalizeContent?, presentCall?, presentResult?,
}))
```

执行流水线 `ctx.tools.execute()`：

```
tools/pre-execute  (waterfall → PreToolDecision: allow | deny | cancel | ask)
ctx.tools.guard()  (单调 ToolGuard，只能否决)
tools/execute      (around：超时 / 重试 / 指标)
tools/post-execute (PostToolDecision: accept{content|value} | block{feedback})
finalizeContent → tools/result (emit)
```

- 参数校验失败 `ToolArgsError(INVALID_ARGS)`，输出不合 schema `ToolOutputError(INVALID_TOOL_OUTPUT)`。参数**不可**在 pre 阶段改写（已落日志）。
- `ask` 决策交给 `ctx.approval.request()`，仅 `allowed-once` 放行；无 answerer 则 `unavailable` 失败关闭。
- PTC 模式（Programmatic Tool Calling，`presentAs('ptc')`）下模型只看到 `run_code`，在隔离 Node / Python 进程里以程序方式调其他工具。本项目非必需。

## 4. LLM adapter 与 deepseek-flash

- 服务 `ctx.llm`：`registerAdapter(providers: string[], adapter)`、`stream(GenerateOptions)`、`prepareCall()`、`resolveModelInfo()`、`listModels()`。
- Adapter 契约：`class X extends LlmAdapter { async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> }`，chunk 协议 `block-start / text-delta / tool-call-delta / block-end / usage / finish{kind}`；错误抛 `LlmError(code)`。
- **deepseek-flash 直接用 `@deepseek-ai/dsh-llm-deepseek`**，路由名 `deepseek-official`：

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    protocol: messages # 或 chat-completions
    reasoningEffort: off # off | low | high | max；分类抽取类任务建议 off
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-flash
```

默认 catalog：`deepseek-flash`（1M 上下文，支持图像，`systemPromptUpdate: in-history`）与 `deepseek-v4-pro`（文本）。错误码 `AUTH / QUOTA / RATE_LIMIT / CONTEXT_WINDOW_EXCEEDED / TIMEOUT ...`，retry policy 由 `dsh-llm-retry` 执行。也可用 `dsh-llm-pi-ai` 接 OpenAI / Anthropic 兼容网关。

## 5. Jev 怎么接（结论：不做 adapter）

adapter 契约是"对话消息 → 流式 ContentBlock"，被 agent loop 当作生成模型驱动 turn。Jev 是"state + questions → 类型化概率决策"，无流式文本、无 tool-call 语义，硬套 adapter 会让日志与 `deriveMessages()` 语义失真。正确接法三选一或组合：

1. **Service seam**：写 `ctx.jev` 服务插件（Definition / Provider / Consumer 三角色），封装 `POST https://api.typesafe.ai/v1/systemone`。
2. **Tool**：`classify_demand`、`score_match` 等工具内部调 `ctx.jev`，判决通过 `tool/result` 落日志，满足 model-visible-means-logged。
3. **Waterfall 门控**：在 `agent/pre-step`（这条消息要不要进模型）、`tools/pre-execute`（置信度不足 → `deny` / `ask`）、`tools/post-execute`（回复值不值得发）里直接调 `ctx.jev`，把 Jev 的概率变成 `PreToolDecision`。**这是把 PRD 里"放行与策略层"落在 dsh 里的自然位置。**

## 6. 子系统与本项目场景的匹配

| 子系统                                                               | 是什么                                                                                                                                                                                                                                                      | 对本项目                                                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **subagent** `ctx.subagents`                                         | `start(name, { prompt, outputSchema?, toolFilter?, persona?, maxDepth? }) → { result: Promise<{ output, structured?, stopReason }> }`；provider 有 in-process spawn / fork、acp、dsh-sdk 等                                                                 | 可用 `outputSchema` 派受限子 agent 做结构化抽取；每个子 agent 是完整 session，偏重                                               |
| **workflow** `ctx.workflowEngine`                                    | 模型写 JS 编排脚本在 PTC 沙箱跑，脚本内 `agent() / parallel() / pipeline()`                                                                                                                                                                                 | 面向模型动态编排，不是固定确定性流水线                                                                                           |
| **schedule** `dsh-schedule`                                          | **session-local** 提醒：`after_seconds / at / every_seconds(≥300)`，到期等 agent idle 后 `followup()` 一条 turn；无 cron、无外部通知、进程关则停                                                                                                            | **不够**做供应商复核、日报等周期作业，需外部 cron                                                                                |
| **goal** `ctx.goals`                                                 | 同 session 持久目标 + 自动 goal round                                                                                                                                                                                                                       | 面向长程编码任务，无关                                                                                                           |
| **agent-team** `ctx.agentTeams`                                      | experimental：Lead + teammate + mailbox + 任务 DAG                                                                                                                                                                                                          | 不建议做生产骨架                                                                                                                 |
| **jobs** `ctx.jobs`                                                  | 进程内后台作业注册表                                                                                                                                                                                                                                        | 非持久                                                                                                                           |
| **webhook** `ctx.webhookRuntime`                                     | `register(rule{ id, kind, run(delivery, signal) → WebhookSessionRequest \| null })` + `dispatch()`；每次投递**新建** Workspace Session；fire-and-forget，**无队列 / 重试 / 去重 / 完成态**；只有 GitHub adapter                                             | 概念上最接近 "Telegram 消息 → session"，但要自写 Telegram adapter，且每次投递新建 session 不符合"按群 / 按需求线程延续"的需要    |
| **approval** `ctx.approval` / **user-questions** `ctx.userQuestions` | `request({ agent, toolName, reason, signal }) → 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`；**turn 内同步阻塞等人答**，无持久审核队列、无跨重启恢复；SDK 协议明言 server→client 审批通道 "dead capability ... for future approval flows" | **人工审核队列必须外置**。可行做法：turn 1 产出草案并落库后结束；运营批准后由外部 `followup()` 一条 "approved, send" 进入 turn 2 |
| **mcp** `dsh-mcp-client` / `dsh-mcp-resources`                       | 每个 server 一行配置（stdio 或 Streamable HTTP），工具带 serverName 前缀进 `ctx.tools`，走完整审批流水线；schema 只接受 JSON Schema 子集（`type / oneOf / properties / required / items / enum / const`，不支持 `$ref / allOf / anyOf / format`）           | 供应商库、Telegram 可做成 MCP server 被 dsh 消费；同进程内直接 `defineTool` 更省一层 IPC。dsh 自身作为 MCP server：文档未提及    |

## 7. 外部驱动 dsh 的方式

| 方式                                    | 传输                           | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **JSON-RPC SDK**（`dsh --profile sdk`） | stdio                          | `initialize{ cwd, provider, model, reasoningEffort?, maxTokens? }` → `session/prompt{ sessionId, content } → { messageId }` → `shutdown`；通知 `session.event`（全部 SessionEvent，未过滤）、`session.status`、`subagent.*`。无 cancel、无 session close、无 per-prompt result（客户端自己等 idle）。TS 客户端 `@deepseek-ai/dsh-sdk-client`，Python `deepseek-harness-sdk`（`DeepSeekHarness(...).run(prompt, session_id=...)`，必须显式 `dsh_home`） |
| **ACP**（`dsh --profile acp`）          | stdio                          | 标准 ACP v1：`session/new \| list \| resume \| close \| prompt \| cancel \| set_config_option \| request_permission`。比 SDK 协议完整                                                                                                                                                                                                                                                                                                                  |
| **Typert API Gateway**（web）           | HTTP `POST /api/<ns>/<method>` | Web Client ↔ Host 的一元 RPC，面向浏览器信任边界；**未见给第三方服务的公开 HTTP / WS API 规范**                                                                                                                                                                                                                                                                                                                                                        |
| **进程内插件**                          | 无                             | 把 Telegram ingestion 写成 dsh 插件（`inject: ['agents']`），自己起长轮询 / HTTP，调 `ctx.agents.create()` / `agent.followup()`。这是最贴合 "everything is a plugin" 的路径，webhook 子系统自己就是这么做的                                                                                                                                                                                                                                            |

**结论**：没有现成的 HTTP / WebSocket 服务 API。要么以子进程 + stdio 托管，要么把摄入服务写成 dsh 插件随 profile 启动。

## 8. 诚实评估

**错配 / 风险**

1. **无消息总线 / 队列 / 调度语义。** 唯一入口是 agent inbox；无跨进程队列、重试、去重、幂等；schedule 无 cron。Telegram 摄入、重投、限流全部自建。
2. **外部驱动只有 stdio**，无 HTTP / WS 服务 API。
3. **人工审批是 turn 内阻塞模型**，审核队列必须外置。
4. **每 session 一份不断增长的 JSONL + 完整 prompt 重放**；compaction 为编码上下文设计，对群消息噪声未必合适。
5. **确定性弱**：classify → extract → match → gate → reply 靠 prompt 引导模型逐步调工具，不是引擎保证的 DAG；要靠 `tools/pre-execute` guard 和 `agent/turn-stopping` 兜底。
6. **成熟度**：0.1.6-alpha，"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"，未做安全审计；`ctx.*` 服务 80+ 个，学习与升级成本高。
7. **隐私默认值**：`session-log-deepseek` 默认开启（把 session 日志随请求上传给 DeepSeek）。处理伦敦用户地址、电话时必须在 profile 里显式 `session-log-deepseek.enabled: false`，并关掉 OTel telemetry。UK GDPR 场景下这是硬要求。
8. **Jev 无自然位置**，需按 §5 自行集成。

**真正有价值的部分**

- **插件组合与 seam 模式**：Definition / Provider / Consumer 三角色 + YAML 替换 provider，适合把 supplier DB、Telegram、Jev 各做成可替换 seam；HMR 热替换。
- **工具流水线**：类型化 schema、参数 / 输出校验、`pre / execute / post` waterfall + 单调 guard、`ask` 审批、超时、并发分类。一个成熟的"可审计工具调用"骨架，与 PRD 的置信度门控高度契合。
- **事件溯源 session**：append-only 日志、`request/header` 精确重建每次模型请求、`assistant/attempt` 保留失败尝试、SQLite 检索、可换后端。天然的轨迹与审计数据源，`dsh-llm-replay` 可回放做回归评测。这直接对应 PRD §9 的 Intent precision 抽检和离线回放。
- **Token 计量与遥测**：`ctx.tokenMeter`、`dsh-session-stats`、`session-telemetry-otel`。对应 PRD "每 1000 条消息花多少钱"。
- **LLM 层**：deepseek adapter 完整（双协议、reasoning effort、retry、credentials seam、动态 settings）；`llm/stream` waterfall 可做全局拦截 / 记账。
- **subagent + outputSchema**：现成的"派受限子 agent 拿结构化 JSON"。

## 9. 对本项目的定位建议

把 dsh 定位为 **"每个需求线程的 agent 运行时 + 工具 / 审计 / 持久化底座"**，而不是整个系统的骨架：

- **在 dsh 内**：自定义 profile（从 `sdk-minimal` 出发的独立树，或 `dsh-base` 去掉文件 / shell 工具）+ 自写插件：Telegram ingestion（进程内插件）、supplier DB seam、Jev seam、gating waterfall、`classify / extract / match / reply / push_lead` 工具。
- **在 dsh 外**：消息队列与幂等、cron（供应商复核、日报）、人工审核队列与审批台、Demand 数据域、供应商库、指标看板。
- **Session 划分**：一条需求 = 一个 session（短、可审计），而不是一个群一个 session（无限增长）。群级上下文由工具查询 Demand 库提供。

若团队最终更看重确定性流水线与低延迟，可只借鉴 dsh 的工具流水线与日志设计，用一个手写状态机替代 agent loop。这一取舍留到技术架构设计文档里定。
