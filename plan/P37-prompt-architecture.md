# P37 提示词与运行时分层

用户授权：以 goal 模式重构规则/业务/SOUL/输入边界/收尾/历史案例及校验。

- [x] 提示词与工具契约回归（先红后绿）
- [x] 稳定规则与纯粹 SOUL；场景工作流按需装配
- [x] 规划、执行、收尾的独立协议；工具白名单与提示词同源
- [x] 结构化运行时数据通过低权限输入传递，避免注入系统指令及跨轮持久化
- [x] 提炼历史案例，保留领域硬规则并补架构/行为测试
- [x] SDK 输入过滤 PoC、完整本地回归、报告与可复现评测

兼容：保留 legacy 注入调用者；生产 answerRequests/taskRequests 路径切换新架构。不增加模型调用或外部权限，不改变 JEV/审批/发送门。无真实模型凭据时明确只验收结构和行为契约。

## 完成记录（2026-10-18）

基于 P36 commit `10a93ec`；分支 `feat/p37-prompt-architecture`。实现集中在 agent 包，另有本地审计脚本及文档。无数据库迁移、新依赖、新发送路径或新增个人数据字段。

- 稳定规则、场景流程与工具集合分离；生产运行按目录服务/市场/信息/健康服务获取/官方/生活活动/不支持请求选择。
- SOUL v3 只保留风格，不保留价格、商家、医疗及预算解读示例。
- 规划、执行、收尾、状态协议独立；无任务时移除更新协议，完成/感谢不开放研究工具。
- 每轮 JSON 上下文走 user 消息；归属校验、输入预算、显式证据省略，使用真正 SDK 及 Chat Completions 序列化验证，不伪造工具结果。
- 旧 legacy 模式压缩并隔离；动态用户内容同样不再拼入其系统指令。
- 增加工具装配与提示词引用运行时校验。实际发现并修复无候选任务时提示词仍引用 update_task 的矛盾。
- 历史案例提炼为主体归属、条件作用域、时间窗口、背景与目标、用户确认等原则；原冻结对话及工具回归保留。

验证：`pnpm check` 全通过，134 文件、1160 测试；PostgreSQL 17.10/Redis 7.4.2 均在本地隔离端口。新增 20 项架构/SDK/输入边界测试。12 个冻结任务案例在 strict/targeted 下各执行一遍。

`node --import tsx scripts/local/prompt-audit.mts`：27 组场景/阶段装配通过。规划 4780 字符，执行 3099–5773 字符，收尾 3992 字符。旧最小执行提示词为 18073 字符、旧规划 8958 字符；字符数不等于 token 数，也不是质量分数。

`node --import tsx packages/eval/src/cli.ts --skip-metrics`：92 个已有入站录制 fixture；precision/recall/silenceCorrect 均 1，categoryAccuracy 91/92。仅为旧入站评价回放，不能用于证明新生成提示词质量。

SDK 输入过滤验证：真实 Runner 两轮刷新数据、不持久化注入包、不误删伪造 JSON 用户文本；实际 Chat Completions adapter 的模型请求中数据仍是 user role，未添加非标准 API 字段。阶段/场景验证见 agent/tests/prompt-architecture.test.ts。

范围限制：没有真实模型凭据，未跑真实生成质量 A/B，也未验证 Telegram 线上收发。场景选择目前仍是确定性的主题/任务路由；复杂混合主题需持续增加留出集。输入包有字符预算，但整个工具历史尚非全面 token 预算管理。分离数据角色不等于全面解决提示词注入。

架构说明：[prompts/README.md](../packages/agent/src/prompts/README.md)。原始本地日志 `/private/tmp/matchbot-p37-check.log`、`/private/tmp/matchbot-p37-prompt-audit.json`、`/private/tmp/matchbot-p37-eval.log`。
