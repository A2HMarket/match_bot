# P13 Phase 0 上线清单

> 本文件是清单不是代码计划。每一项由负责人勾选并写日期。全部勾完才能把首批群的 `phase` 置 0 并让 worker 上线；Go / Pivot 会议以本文件与 `pnpm eval` 输出为依据。

**Spec:** `docs/技术架构设计.md` §7、§9、§12；PRD §9、§11；Brief §5

## A. 工程就绪

- [x] P1–P12 看板状态全部 `完成`，`main` 上 `pnpm check` 全绿 —— 2026-09-22，45 文件 / 196 用例
- [x] `apps/worker/tests/e2e/shadow.test.ts` 在 CI 通过 —— 新增 `.github/workflows/ci.yml`（Postgres 17 + Redis 7 service container，`migrate deploy` → `pnpm check` → 离线 eval）。本地已验证 `--frozen-lockfile` 同步、`migrate deploy` 可用、`pnpm check` 与 `pnpm eval` 无需任何密钥即可跑。**首次真实运行结果待首个 PR 确认**
- [ ] `.env` 生产值就位：`DEFAULT_PHASE=0` ✅、Jev 与 DeepSeek key ✅、**`TELEGRAM_OPS_CHAT_ID` 仍借用测试群 `-5372233317`（伦敦吃喝玩乐），上线前必须换专用运营群**
- [ ] 部署：bot 与 worker 两个进程常驻，崩溃自动重启，日志落盘 —— **未做，需先定部署目标**（VPS + systemd / docker compose / 托管平台）。另见下方「Redis 实例隐患」
- [ ] `session-log` 类上传全部关闭：Agents SDK tracing 已替换 ✅（PoC V6 用 fetch + socket 双探针证明只联 api.deepseek.com，对照组能抓到默认 exporter 打 api.openai.com）；**Jev ZDR ❌ 未落实**，见下方专条
- [x] cron 三个 job 在 Redis 里可见 —— 2026-09-22 实测 `getJobSchedulers()` 返回 `redact_messages`(6h)、`expire_demands`(24h)、`expire_run_states`(1h)，Redis 中有对应 `bull:cron:repeat:*` key

## B. 数据就绪

- [ ] `suppliers` 录入 Brief §3 的 30 家 B 池 —— **机制已就绪**：`scripts/seed/seed.ts` + `data.example.json`，zod 校验、幂等 upsert、`--dry-run` 预览，已实测写入/重跑/清理。**当前 0 行，等真实业务数据**
- [ ] A 池转化：≥ 3 家 `isWillingToReceiveLeads = true` —— 需 BD 沟通。seed 脚本已强制校验「A 池必须有 telegram 或 whatsapp」，缺失即整体中止
- [ ] `groups` 表：首批 8 个群登记 —— 机制同上；seed 的 `isActive` **默认 false**，需管理员同意后手动开（PRD §6.2）。当前 0 行
- [ ] `@adslondon` 不进 Bot，走管理员 BD（Brief §4 特殊处理）
- [x] 标注样本 ≥ 50 条，语种覆盖齐全 —— 实测 50 条，zh/en/ru/uk/pt **各 10 条**；22 需求 / 28 非需求

## C. 合规

- [ ] Bot privacy mode 关闭 ✅（PoC V5 实测 `can_read_all_group_messages: true`，并收到一条不 @ bot 的真实群消息）；**每个群管理员的知情同意 ❌ 未开始**，需人工沟通并记入 `groups.adminContact`
- [x] `messages.text` 30 天置空的 cron 已验证跑过一次 —— 2026-09-22 实测：插入 31 天前与当天各一条，`redactOlderThan(30)` 影响 1 行，旧条 `text` 变 `""` 且 `text_hash` 留存，当天条未受影响
- [ ] DeepSeek API 数据处理条款已阅并记录结论（架构 §9 前置风险）
- [x] 隐私说明文本准备好 —— `docs/隐私说明-群管理员.md`（起草完成）。**但文中「数据去了哪里」一节带了拦截标记：在 C+.1 的 Jev ZDR 与下面的 DeepSeek 条款结论落实之前不得对外发**，否则等于对管理员做了无法兑现的承诺

## C+. 两条需要决策的阻塞（2026-09-22 核查发现）

### C+.1 Jev ZDR 无法按请求设置，也无法自证

AGENTS.md §6 要求「Jev 请求带 Zero Data Retention」。`packages/jev/src/client.ts` 里 P4 留了诚实的 TODO，未实现。本次尝试落实，结论是**不能靠加字段解决**：

- 我们经 OpenRouter 的 `/api/alpha/decisions` 调 Jev。实测 `{"zdr": true}` 与 `{"provider":{"data_collection":"deny"}}` 都返回 HTTP 200。
- **但反向对照证明这什么都不说明**：塞一个纯胡编的字段 `{"this_field_is_nonsense_xyz": true}`、以及非法类型 `{"zdr":"not-a-boolean"}`，同样返回 200。该端点静默忽略未知字段与错误类型。
- `GET /api/v1/key` 不暴露训练/留存策略（只有 `allowed_data_regions: ["global"]`）。

因此在客户端加 `zdr: true` 属于 cargo cult —— 可能毫无作用，却制造合规已达成的假象，比现在的 TODO 更危险。**待办**：① 在 OpenRouter 账号设置（openrouter.ai/settings/privacy）里确认并截图留存数据策略；② 或向 TypeSafe 确认直连 `api.typesafe.ai` 的 ZDR 字段名并申请一把直连 key。在此之前**不应认为 Jev 侧已满足 §6**。

### C+.2 本机 Redis 不是 compose 起的那个

`pnpm infra:up` 会起 `match_bot-redis-1`（redis:7-alpine，绑 `*:6379`），但本机还有一个 Homebrew 的 `redis-server` 常驻在 `127.0.0.1:6379`（自 2026-09-10）。`localhost` 解析到 127.0.0.1，**所有连接实际打到 Homebrew 那个**，容器 Redis 始终 `DBSIZE=0`。

目前没有数据混用（该实例 24 个 key 全是 `bull:` 前缀），但：它不受 `pnpm infra:down` 管辖、版本与持久化配置都没钉死、换台机器行为就变。上线前必须确定生产用哪个 Redis，并让本地与之一致（建议停掉 Homebrew 实例让项目走 compose；CI 已用 service container，不受影响）。

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
