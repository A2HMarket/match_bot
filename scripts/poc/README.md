# PoC 脚本

对应 `docs/技术架构设计.md` §11 的 V1–V6。每个 PoC 一个目录，跑通后在本文件登记结论与日期；PoC 代码不进 packages，也不要求通过 lint（`eslint.config.js` 已忽略 `scripts/poc/**`）。

每个目录下的 `RESULT.md` 是该项的完整结论（通过/未通过 + 证据 + 对 P8 的影响），本表只做索引。

| 编号                         | 目录                  | 结论                                                                                                        | 日期       |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| V1 deepseek-flash 多工具调用 | `v1-deepseek-tools/`  | **通过** 10/10，p50 1458ms / p95 1826ms（`stop_on_first_tool`）；默认双轮 p50 2848ms                        | 2026-09-21 |
| V2 RunState 跨进程恢复       | `v2-runstate-resume/` | **通过** 跨进程恢复完整；重复恢复 SDK 不拦截（必须自己原子消费）；最小快照 22.7KB                           | 2026-09-21 |
| V3 Postgres Session          | `v3-pg-session/`      | **通过** 历史跨轮带入，每轮 +2 条；`reasoning_content` 会落库需剥离                                         | 2026-09-21 |
| V4 Jev 入站 precision        | `v4-jev-inbound/`     | **通过** n=50 precision 1.00 / recall 1.00 / category 0.98，p50 324ms p95 408ms，$0.0000457/条              | 2026-09-21 |
| V5 grammY 收群消息           | `v5-telegram-groups/` | **通过** 实收一条不 @ bot 的群消息；`chat.id` 负且超 32 位、`language_code` 实测缺失、建群服务消息需过滤    | 2026-09-21 |
| V6 自定义 tracing processor  | `v6-tracing/`         | **通过** 5 类 span（比预期多 task/turn）；usage 在 `turn`/`task` 不在 `generation`；确认不发 api.openai.com | 2026-09-21 |

## 复跑方式

```bash
cd <repo> && set -a && . ./.env && set +a
pnpm exec tsx scripts/poc/v1-deepseek-tools/main.ts          # POC_STOP_ON_FIRST_TOOL=1 等开关见 RESULT.md
pnpm exec tsx scripts/poc/v2-runstate-resume/pause.ts && pnpm exec tsx scripts/poc/v2-runstate-resume/resume.ts
pnpm exec tsx scripts/poc/v3-pg-session/main.ts              # 需要 pnpm infra:up
pnpm exec tsx scripts/poc/v4-jev-inbound/main.ts
POC_V5_TIMEOUT_MS=90000 pnpm exec tsx scripts/poc/v5-telegram-groups/main.ts
pnpm exec tsx scripts/poc/v6-tracing/main.ts                 # --control 对照组保留默认 exporter
```

## 环境前提

PoC 需要根 `.env` 里的 `DEEPSEEK_API_KEY`（V1/V2/V3/V6）、`JEV_API_KEY`（V4）、`TELEGRAM_BOT_TOKEN`（V5）与 `DATABASE_URL`（V3）。

**Jev 走 OpenRouter 的 decisions 端点，不是 typesafe 直连**：`POST ${JEV_BASE_URL}/decisions`，`JEV_BASE_URL=https://openrouter.ai/api/alpha`，`JEV_MODEL=typesafe/jev-1.13`。直连 `api.typesafe.ai/v1/systemone` 用这把 key 会 401，别再试。
