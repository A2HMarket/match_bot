# Agent Harness 选型对比：DeepSeek / Claude / OpenAI

| 项       | 内容                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整理日期 | 2026-09-21                                                                                                                                                                                                                                                     |
| 前提     | 已确认的产品形态：多轮需求补充、跨群用户记忆、群内供需双向撮合、人工审核、可扩展新品类与渠道。生成模型意向 deepseek-flash，决策模型 Jev（详见 [deepseek-harness.md](./deepseek-harness.md)、[jev-decision-model.md](./jev-decision-model.md)）                 |
| 来源     | dsh 仓库文档；Anthropic Claude API / Managed Agents / Agent SDK 文档；OpenAI Agents SDK（Python / TypeScript）文档 https://openai.github.io/openai-agents-python/ 、https://openai.github.io/openai-agents-js/ ；OpenAI AgentKit 公告与 Agent Builder 退役通知 |

## 1. 三家各自的"harness"到底是什么

| 厂商      | 产品                                                                                       | 形态                                                                                                                                                                        | 模型                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| DeepSeek  | **dsh**（deepseek-harness）                                                                | 开源 TS，coding agent harness，Cordis 插件树，只能 `dsh --profile` 启动                                                                                                     | 模型无关（自带 deepseek adapter + pi-ai 通用 adapter）                                                                |
| Anthropic | **Claude API + Tool Runner**                                                               | SDK 内的薄循环，你写工具函数，自己托管                                                                                                                                      | 仅 Claude                                                                                                             |
| Anthropic | **Managed Agents**（beta，2026-04）                                                        | 托管：Anthropic 跑 loop + 每 session 一个沙箱容器；Agent 对象版本化；memory stores、scheduled deployments、webhooks、vaults、outcomes、multiagent、permission policy `auto` | 仅 Claude                                                                                                             |
| Anthropic | **Claude Agent SDK**                                                                       | Claude Code 打包成库：内置文件 / bash / web 工具、hooks（PreToolUse 等）、subagent、session resume、自定义工具经进程内 MCP                                                  | 仅 Claude                                                                                                             |
| OpenAI    | **Agents SDK**（Python / TS，开源）                                                        | Agents / Tools / Handoffs / Guardrails 四原语；Sessions 多后端；HITL `needs_approval` + RunState 序列化；tracing；MCP                                                       | 模型无关：`OpenAIChatCompletionsModel` 接任何 OpenAI 兼容端点，LiteLLM / Any-LLM 适配器，TS 版有 Vercel AI SDK 适配器 |
| OpenAI    | **Responses API / AgentKit**（ChatKit、Connector Registry；Agent Builder 2026-11-30 关停） | 托管会话、内置工具                                                                                                                                                          | 仅 OpenAI                                                                                                             |

## 2. 按我们的需求逐项对照

| 维度                         | dsh                                                     | Claude Agent SDK                              | Claude Managed Agents                                                       | OpenAI Agents SDK                                                                                             |
| ---------------------------- | ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 生成模型用 deepseek-flash    | ✅                                                      | ❌ 必须 Claude                                | ❌ 必须 Claude                                                              | ✅ Chat Completions 模式                                                                                      |
| Jev 当控制器（选下一步动作） | ❌ loop 由 LLM 选工具；只能在 waterfall 否决            | ❌ loop 由 Claude 驱动；hooks 只能否决 / 注入 | ❌ loop 在 Anthropic 侧                                                     | ⚠️ loop 仍由 LLM 选工具，但 input guardrail、`needs_approval` 条件函数、handoff 路由都可由 Jev 决定，贴得最近 |
| 会话与多轮                   | ✅ append-only 日志，resume                             | ✅ session resume                             | ✅ 托管 session，事件流                                                     | ✅ Sessions：SQLite / Redis / SQLAlchemy / Mongo / Dapr / 加密                                                |
| 跨会话用户记忆               | ❌ 自建（仅 MCP memory 指南）                           | ⚠️ 自建（memory 工具需自己实现后端）          | ✅ memory stores（FUSE 挂载、版本化、可 redact）                            | ⚠️ 自建（session 是对话历史，非用户画像）                                                                     |
| 人工审核可持久、跨进程       | ❌ turn 内阻塞                                          | ❌ hooks 内同步决定                           | ✅ `tool_confirmation` 事件，session 可 idle 等待；permission policy `auto` | ✅ `RunState.to_string()` 落库，另一进程 `from_json` 后 `approve / reject` 再 run                             |
| 周期作业                     | ❌ session-local，无 cron                               | ❌                                            | ✅ scheduled deployments                                                    | ❌ 自建 cron                                                                                                  |
| 外部事件驱动                 | ⚠️ webhook 子系统新建 session，无队列                   | ⚠️ 自建                                       | ✅ webhooks（Anthropic → 你）；触发侧自建                                   | ⚠️ 自建                                                                                                       |
| 工具门控 / 审计              | ✅ 最强：pre / execute / post waterfall + guard + `ask` | ✅ PreToolUse / PostToolUse hooks             | ⚠️ 权限策略在 Anthropic 侧，你处理 `tool_confirmation`                      | ✅ guardrails（input / output / tool）+ `needs_approval` + tracing processor                                  |
| 嵌入自己的服务               | ❌ 只能 `dsh --profile`，stdio 驱动                     | ✅ 库                                         | ✅ REST / SDK                                                               | ✅ 库                                                                                                         |
| 追踪 / 评测                  | ✅ 事件溯源日志、replay                                 | ⚠️                                            | ✅ Console session viewer、outcomes 评分                                    | ✅ tracing（默认上传 OpenAI，可禁用或自定义 processor）                                                       |
| 数据驻留 / 合规              | ⚠️ 默认上传 session 日志给 DeepSeek，需关               | Anthropic 30 天保留策略                       | `inference_geo` 可钉住推理地域                                              | 自托管时数据在你手里；tracing 需关                                                                            |
| 成熟度                       | 0.1.6-alpha                                             | GA                                            | beta                                                                        | GA（Swarm 后继，2025 起）                                                                                     |

## 3. 关键判断

1. **模型锁定是分水岭。** Claude 的三条路都要求把生成模型换成 Claude（Haiku 4.5 $1/$5，Sonnet 5 $2/$10 每百万 token）。换了模型，Managed Agents 提供的托管 session、memory store、cron、webhook 恰好是 dsh 之外要自建的那一堆。这是一个真实的权衡，不是坏事，但要明确说出来。
2. **"Jev 当控制器"在四家都做不到原生。** 所有 harness 的 loop 都是 LLM 选工具。差别在于 Jev 能贴多近：OpenAI Agents SDK 的 guardrail 和 `needs_approval` 条件函数是显式的前置 / 门控钩子，Jev 可以在"进模型前"和"执行工具前"两处决策；dsh 和 Claude Agent SDK 的 hook 只能否决；Managed Agents 的 loop 在 Anthropic 侧，Jev 只能是 custom tool 或在 `tool_confirmation` 时由你侧决定。若坚持 Jev 完全当控制器，任何 harness 都要改成"状态机 + 按需调 LLM"，那就回到手写。
3. **Claude Agent SDK 与 dsh 同类。** 都是 coding harness 打包成库，默认工具是文件 / bash，非编码用途要关掉大部分内置工具再挂自定义 MCP 工具，且多一层模型锁定。它比 dsh 成熟，但不比 dsh 更贴合。
4. **OpenAI 托管侧不考虑。** Responses / AgentKit 要 OpenAI 模型，Agent Builder 已宣布退役。
5. **OpenAI Agents SDK 的代价**：Chat Completions 模式丢失 tool search、programmatic tool calling 等 Responses 专属功能；结构化输出依赖端点支持 JSON schema（deepseek 支持）；tracing 默认上传 OpenAI，必须 `set_tracing_disabled` 或自定义 processor；LiteLLM / Any-LLM 适配器标注 best-effort beta。

## 4. 推荐

**坚持 deepseek-flash + Jev 的前提下：OpenAI Agents SDK。** 它是唯一同时满足模型无关、HITL 可持久跨进程、多后端 session、显式 guardrail 钩子的选项。语言二选一：

- **TypeScript**：`@openai/agents` + `@openai/agents-extensions` 的 AI SDK 适配器，deepseek-flash 与 Jev 的 `evaluate` 走同一个 AI SDK 层；grammY 接 Telegram。
- **Python**：Agents SDK 更成熟，Sessions 后端更全；Jev 走 Pydantic AI 或直接 HTTP；aiogram 接 Telegram。

**若愿意把生成模型换成 Claude 且想少运维：Claude Managed Agents 值得认真评估。** 托管 session、memory store、scheduled deployments、webhooks、outcomes 覆盖了我们外围自建的大部分。代价是模型锁定、beta、loop 不在自己手里、Jev 只能做工具或确认时的判定。适合作为 Phase 2 之后的备选，而不是 Phase 0 的起点。

**不推荐**：Claude Agent SDK（coding harness + 锁定），OpenAI 托管 AgentKit（锁定 + 退役中），dsh（入口与 HITL 问题见 deepseek-harness.md）。

## 5. 待核实

- OpenAI Agents SDK TS 版的 `RunState` 序列化 API 与 Python 版是否等价（Python 已核实 `to_state().to_string()` / `RunState.from_json`）。
- AI SDK 适配器对 deepseek-flash 的 tool calling 与 JSON schema 输出的实际兼容性，需要跑一个最小验证。
- Managed Agents 的 UK 数据驻留选项与价格，只在换 Claude 路线时需要。
