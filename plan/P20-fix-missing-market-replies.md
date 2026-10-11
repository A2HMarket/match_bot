# P20 — 修复真实请求漏回复

范围：agent 包内部工具编排与出站评估输入，不新增发送路径，不改 Jev 阈值或问题集。

- [x] 核对 2026-10-11 14:43 UTC 三条真实消息的 traces、session 与出站状态。
- [x] 写失败回归，复现两次证据失败后正常补搜耗尽三次机会。
- [x] 区分 research_required 与 invalid_evidence；补搜继续留痕但不占纠错预算。
- [x] 使用本轮约束后的 MarketPlan 构造出站评估需求，避免建档失败时残留的打印机需求/预算。
- [x] 建档字段错误返回全部路径，指导一次补齐 nullable 必填字段，不放宽 schema。
- [x] 全量 check/build/eval、三条真实只读预览及出站判断复核。
- [x] 提交、合并 main、重启本地进程并核对运行版本。

## 真实证据

打印机请求 17.3 秒完成并 sent。帮带 23.4 秒完成但无出站：日期冲突两次，第三次正常缺口补搜被错误计为 invalid_evidence，触发 input_retry_limit。桌椅 22.0 秒完成但无出站：四次 upsert_demand 缺字段未成功，沿用原开放打印机需求；Jev worthReplying=0.08、rateOk=true，出站 drop。三条均 entered_agent；不是丢入站消息、频控或超时。

## 设计边界

不允许日期冲突通过，不移除三次真正错误的上限，不绕过 Jev/审批/Phase 0。出站评估只使用本轮已校验的计划；原未指定的预算不继承。内部 draft 新增 evaluationDemand，可选，其他工具行为不变。没有新增数据库或身份/联系方式字段，沿用原 trace/session 保留策略。

## 完成记录

两条失败回归先 RED 再 GREEN：两次无效证据后正常补搜仍能执行并出站；建档遗漏字段可一次补齐。额外断言桌椅评估不携带打印机预算、Jev 不可用仍降级，真正三次错误仍终止。

三条截图原文真实预览各生成一份草稿：打印机 14.355s，帮带 17.712s，桌椅 24.922s。再次刻意注入历史 laser printer/6000pence 需求，调用真实 Jev 与生产出站工具（只写内存），三条均 auto，worthReplying 分别 2.67/1.56/2.61。帮带只有带未知日期/年份的备选，未宣称存在已确认 2026 年11月供给。这是各一次实测，不能作为生产成功率。

92 条 fixture 入站评测 precision/recall/silenceCorrect=1，categoryAccuracy=0.98913（既有 s39 差异）。完整 check 第一次因 lint 类型断言失败，修复；第二次本机集成连接被 sandbox EPERM，获得本机测试库访问后重跑。最终 pnpm check 全绿：64 文件、536 测试；pnpm build 通过。部署前 inbound/resume/outbound active/waiting/delayed=0，pending snapshots=0。本地重启 worker PID70464、bot PID70476，均 running；新日志确认启动，两个 stderr 新增0字节；dist AGENT_VERSION=0.13.1。全局默认phase0、既有群phase配置不改。代码经 codex/fix-missing-market-replies 提交并合并本地主干，不涉及远端推送。

不新增依赖、外部发送路径或个人数据字段；SDK未升级。预览全部为内存仓储，未发送测试消息。计数与真实 Jev 结果保存 scripts/poc/p20-missing-replies/results-2026-10-12.json。
