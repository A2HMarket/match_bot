# P13 Phase 0 上线清单

> 本文件是清单不是代码计划。每一项由负责人勾选并写日期。全部勾完才能把首批群的 `phase` 置 0 并让 worker 上线；Go / Pivot 会议以本文件与 `pnpm eval` 输出为依据。

**Spec:** `docs/技术架构设计.md` §7、§9、§12；PRD §9、§11；Brief §5

## A. 工程就绪

- [ ] P1–P12 看板状态全部 `完成`，`main` 上 `pnpm check` 全绿
- [ ] `apps/worker/tests/e2e/shadow.test.ts` 在 CI 通过
- [ ] `.env` 生产值就位：`DEFAULT_PHASE=0`、真实 `TELEGRAM_OPS_CHAT_ID`、Jev 与 DeepSeek key
- [ ] 部署：bot 与 worker 两个进程常驻（systemd / docker compose），崩溃自动重启，日志落盘
- [ ] `session-log` 类上传全部关闭：Agents SDK tracing 已替换（V6 结论），Jev 请求带 ZDR
- [ ] cron 三个 job 在 Redis 里可见（`redact_messages`、`expire_demands`、`expire_run_states`）

## B. 数据就绪

- [ ] `suppliers` 录入 Brief §3 的 30 家 B 池，字段完整（`serviceArea` 用 outward code 或 `LONDON`）
- [ ] A 池转化：≥ 3 家 `isWillingToReceiveLeads = true`，`telegram` 或 `whatsapp` 联系方式已验证
- [ ] `groups` 表：首批 8 个群登记，`isActive = true`，`phase = 0`，`categoriesEnabled` 填好
- [ ] `@adslondon` 不进 Bot，走管理员 BD（Brief §4 特殊处理）
- [ ] 标注样本 `packages/eval/fixtures/labeled-inbound.json` ≥ 50 条，语种覆盖 RU / UA / EN / PT / ZH

## C. 合规

- [ ] Bot privacy mode 关闭（V5），且每个群的管理员已知晓 Bot 在监听并同意（记录在 `groups.adminContact`）
- [ ] `messages.text` 30 天置空的 cron 已验证跑过一次
- [ ] DeepSeek API 数据处理条款已阅并记录结论（架构 §9 前置风险）
- [ ] 隐私说明文本准备好，管理员询问时可发

## D. Shadow 期观测（Day 4–8）

- [ ] 每日运行 `pnpm eval`，把结果贴到本文件下方"每日记录"
- [ ] Day 6 用 Shadow 数据校准阈值（`packages/gating/src/thresholds.ts`），附评测对比
- [ ] 抽检 ≥ 100 条 `dry_run` 拟发内容，标注"可以发 / 不该发 / 需改"，记录比例
- [ ] 确认无一条 `outbound_messages.status = sent`

## E. Phase 1 放行前置

- [ ] 运营群建好，审批卡收发验证过（P11 Task 3 冒烟）
- [ ] 至少 1 个群管理员书面同意 Bot 回复
- [ ] Intent precision ≥ 0.9，沉默正确率 ≥ 0.95（PRD §9）
- [ ] 抽检"可以发"比例 ≥ 70%

## Go / Pivot 输入（Day 14）

| 指标 | 目标 | 实际 |
|---|---|---|
| 需求密度（每 1000 条消息） | 基线待建 | |
| Intent precision | ≥ 0.9 | |
| 供应商 24h 响应率 | ≥ 50% | |
| Bot 回复互动率 | 基线待建 | |
| 有效报价 / 成交 | ≥ 5 / 1–3 | |
| 打扰率 / 被踢群 | < 5% / 0 | |
| 每 1000 条消息成本 | 记录 | |

## 每日记录

| 日期 | 消息数 | 需求数 | 进 agent | dry_run | 成本 | 备注 |
|---|---|---|---|---|---|---|
| | | | | | | |
