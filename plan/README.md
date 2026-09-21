# 开发实施计划与进度看板

> 本目录是项目跟进的唯一事实源。每个工作包一个文件，分给不同 agent 并行执行。
> 执行者必须：开工时把看板状态改为 `进行中` 并填负责人；每完成一个 Task 勾掉对应 checkbox；收工时更新状态、PR 链接、`最后更新`，并在文件末尾"完成记录"写结论。
> 执行方式：REQUIRED SUB-SKILL `superpowers:subagent-driven-development`（一个 Task 一个子 agent，任务间评审）或 `superpowers:executing-plans`。

上位文档：[产品需求](../docs/support-agent-产品需求.md) · [技术架构](../docs/技术架构设计.md) · [开发契约 AGENTS.md](../AGENTS.md) · [跨包接口契约](./interfaces.md)

## 看板

状态取值：`待开始` / `进行中` / `评审中` / `完成` / `阻塞`。依赖列出的工作包必须 `完成` 后才能开始（PoC 例外，见各文件）。

| ID | 工作包 | 计划文件 | 依赖 | 波次 | 负责人 | 状态 | PR | 最后更新 |
|---|---|---|---|---|---|---|---|---|
| P0 | PoC 六项验证 | [P0-poc.md](./P0-poc.md) | 无 | 0 | claude (6 并行 agent) | 完成 | [#1](https://github.com/xemaya/match_bot/pull/1) | 2026-09-21 |
| P1 | domain + shared 补全 | [P1-domain-shared.md](./P1-domain-shared.md) | 无 | 1 | claude | 完成 | `feat/P1-domain-shared`（本地合并） | 2026-09-21 |
| P2 | db：迁移与仓储层 | [P2-db.md](./P2-db.md) | P1 | 1 | kimi | 完成 | `feat/P2-db`（本地合并） | 2026-09-21 |
| P3 | queue | [P3-queue.md](./P3-queue.md) | P1 | 1 | | 待开始 | | |
| P4 | jev 客户端与问题集 | [P4-jev.md](./P4-jev.md) | P1, P2 | 1 | | 待开始 | | |
| P5 | gating | [P5-gating.md](./P5-gating.md) | P1, P2 | 1 | | 待开始 | | |
| P6 | matcher | [P6-matcher.md](./P6-matcher.md) | P1, P2 | 1 | claude | 完成 | `feat/P6-matcher`（本地合并） | 2026-09-21 |
| P7 | channel-telegram | [P7-channel-telegram.md](./P7-channel-telegram.md) | P1, P2 | 1 | | 待开始 | | |
| P8 | agent | [P8-agent.md](./P8-agent.md) | P0(V1,V2,V3,V6), P2, P4, P5, P6 | 2 | | 待开始 | | |
| P9 | approval | [P9-approval.md](./P9-approval.md) | P2, P3, P7 | 2 | | 待开始 | | |
| P10 | apps/bot | [P10-app-bot.md](./P10-app-bot.md) | P0(V5), P2, P3, P7 | 2 | | 待开始 | | |
| P11 | apps/worker | [P11-app-worker.md](./P11-app-worker.md) | P8, P9, P10 | 3 | | 待开始 | | |
| P12 | eval | [P12-eval.md](./P12-eval.md) | P8 | 3 | | 待开始 | | |
| P13 | Phase 0 上线清单 | [P13-phase0-launch.md](./P13-phase0-launch.md) | P11, P12 | 3 | | 待开始 | | |

## 波次与并行

```
波次 0  P0 六个 PoC 互相独立，可 6 个 agent 同时跑（需要 API key / bot token）
波次 1  P1 先行（半天）；随后 P2 P3 并行；P2 完成后 P4 P5 P6 P7 四个并行
波次 2  P8 P9 P10 并行（P8 需 PoC V1 V2 V3 V6 结论）
波次 3  P11 串联一切；P12 与 P11 并行；P13 收尾
```

对应两周计划：波次 0–1 覆盖 Day 1–5，波次 2 覆盖 Day 4–8（Phase 0 需要 P11 跑起来），波次 3 覆盖 Day 7–14。

## 分工规则

1. 一个 agent 一次只领一个工作包；领取前确认依赖已 `完成`。
2. 每个工作包在自己的分支 `feat/<ID>-<name>` 上开发，PR 合并到 `main`。初始骨架（本目录建立时的状态）是第一次提交。
3. 跨包接口以 [interfaces.md](./interfaces.md) 为准。要改接口，先改 interfaces.md 并在看板备注，再通知依赖方；不得在自己的包里静默改签名。
4. `pnpm check` 全绿才能标 `评审中`。评审通过标 `完成`。
5. 阻塞时状态改 `阻塞`，并在文件"完成记录"写明卡在哪、需要谁。
6. 计划文件里的代码是起点不是终点：与 interfaces.md 冲突以 interfaces.md 为准；与 SDK 实际行为冲突以 PoC 结论为准，并回写计划。

## 里程碑

| 里程碑 | 定义 | 目标日 |
|---|---|---|
| M1 骨架可跑 | P1–P7 完成，`pnpm check` 全绿，docker 起库后迁移成功 | Day 5 |
| M2 Shadow 上线 | P8–P11 完成，8 个群只听不说，看板有 Demand 数据 | Day 8 |
| M3 首次审批发送 | P9 审批链路跑通，运营群批准后群里出现第一条回复 | Day 11 |
| M4 Go / Pivot | P12 指标出来，P13 清单全勾 | Day 14 |
