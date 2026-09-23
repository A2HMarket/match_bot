# P13 Phase 0 上线清单

> 本文件是清单不是代码计划。每一项由负责人勾选并写日期。全部勾完才能把首批群的 `phase` 置 0 并让 worker 上线；Go / Pivot 会议以本文件与 `pnpm eval` 输出为依据。

**Spec:** `docs/技术架构设计.md` §7、§9、§12；PRD §9、§11；Brief §5

## A. 工程就绪

- [x] P1–P12 看板状态全部 `完成`，`main` 上 `pnpm check` 全绿 —— 2026-09-22，45 文件 / 196 用例
- [x] `apps/worker/tests/e2e/shadow.test.ts` 在 CI 通过 —— 新增 `.github/workflows/ci.yml`（Postgres 17 + Redis 7 service container，`migrate deploy` → `pnpm check` → 离线 eval）。本地已验证 `--frozen-lockfile` 同步、`migrate deploy` 可用、`pnpm check` 与 `pnpm eval` 无需任何密钥即可跑。**首次真实运行结果待首个 PR 确认**
- [ ] `.env` 生产值就位：`DEFAULT_PHASE=0` ✅、Jev 与 DeepSeek key ✅、**`TELEGRAM_OPS_CHAT_ID` 仍借用测试群 `-5372233317`（伦敦吃喝玩乐），上线前必须换专用运营群**
- [x] 部署：bot 与 worker 两个进程常驻，崩溃自动重启，日志落盘 —— 本机 macOS launchd，见 `deploy/local/`。**实测**：`install.sh` 后两服务 state=running；`kill -9` bot 后 15s 内自动拉起（pid 81824 → 81880），`logs/bot.log` 里两条 `bot started` 为证。局限见 `deploy/local/README.md`（node 路径钉死、单长轮询、合盖睡眠、日志不轮转）
- [ ] `session-log` 类上传全部关闭：Agents SDK tracing 已替换 ✅（PoC V6 用 fetch + socket 双探针证明只联 api.deepseek.com，对照组能抓到默认 exporter 打 api.openai.com）；**Jev ZDR ❌ 未落实**，见下方专条
- [x] cron 三个 job 在 Redis 里可见 —— 2026-09-22 实测 `getJobSchedulers()` 返回 `redact_messages`(6h)、`expire_demands`(24h)、`expire_run_states`(1h)，Redis 中有对应 `bull:cron:repeat:*` key

## B. 数据就绪

- [x] `suppliers` 录入 Brief §3 的 30 家 B 池 —— **30 家已入库**（三品类各 10）。数据源是 Brief §3 表格本身（`scripts/seed/extract-brief.ts` 解析 docx，含 45 个超链接），不是抓来的。随后用 `scripts/seed/enrich-suppliers.ts` 访问各家**官网**核实补全（robots.txt 已核，顺序请求 1.5s 间隔）：
  - 电话 30/30，其中 **19 家在官网页面上得到交叉验证**
  - 邮箱 14 家（新增，为此加了 `Supplier.email` 列与迁移 `20260922145834_add_supplier_email`）
  - WhatsApp 9 家（其中 5 家改为官网 `wa.me` 上的真实号码——此前是拿电话凑的）
  - 官网 29/30（Brief 里 17 家原本填的是 Google 搜索链接，用浏览器同源检索补到 16 家真实站）
  - 评价数 11 家、评分 2 家
  - ⚠ **6 家标记「归属存疑」未采信**：搜到的站上找不到 Brief 记录的电话，可能不是同一家；另有 1 家（London Furniture Assembly）只匹配到 `.ca` 域名（疑似加拿大 London），未填。**这 7 家需人工核**
  - **2026-09-23 B 池精校**（`scripts/seed/apply-verification.ts` + gitignore 的 `verified.json`，每条改动附来源页与原文）：
    - **修了一个匹配 bug**：Brief 里的邮编是**所在地**（「E14；07:00-00:00」），此前被当成服务范围，matcher 的 `coversArea` 会把 E14 以外的需求全部排除。现进 `basePostcode`（11 家），服务范围默认全伦敦。实测搬家品类 N1/SE1 需求的候选从 7 家恢复到 10 家
    - 每家抓首页 + 联系/区域/评价子页（共 125 页）而非单页，另用浏览器核 JS 渲染站。**电话核实 19 → 28/30**
    - 用 Brief **电话反查**代替名字搜索，7 家存疑里解决 5 家：The Man Van London 真站是 themanvan.co.uk；Flat Pack Assembly London 是 EM FlatPack（emflatpack.co.uk）；Busy Bee / Kensington Handyman / A1 原站是对的，号码在子页。D&C 此前匹配到的 ddccleaningservices.co.uk 实属 **Daily Domestic Cleaners (DDC) Ltd**，已撤回
    - 评分/评价数只收**点名平台**或结构化数据的：9 家有评分、10 家有评价数。撤掉的包括「8571 条评价」（其实是电话尾号）、「13,972」（自我宣称）等。enrich 脚本不再自动写这两个字段，只报候选
    - Kensington Handyman 按官网收窄到 W4/W6/W8/W11/W12；Good Old Clean 的 Brief 电话在官网不存在，改用官网号；Skycleaners 此前存的是页面上的个人 gmail，改为公司邮箱；Wizard Fix 的 Brief 链接已 404
    - 同日/周末按官网正面陈述重判（排除差评里的 "same day"、"Call 24/7" 电话线等误报）
    - **仍需人工 2 家**：D&C Cleaning Services（Brief 电话在公开网页无记录）、London Furniture Assembly（只有 Nextdoor 登记）。二者 `lastVerifiedAt` 保留 Brief 日期，60 天后自然降权
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
- 2026-09-23 链路自检：向队列注入一条模拟群消息，worker 7.7s 内走完 代码门 → Jev（isDemand 0.95）→ agent 4 轮（upsert_demand / find_suppliers / find_peer_supply / reply_in_group）→ 出站门 `dry_run`，拟发 3 家候选。测试数据已清除。**Telegram → bot 入队这一段仍待真实群消息验证**

## E. Phase 1 放行前置

- [ ] 运营群建好，审批卡收发验证过（P11 Task 3 冒烟）
  - 2026-09-23：`apps/bot` 已注册审批按钮回调（此前是 `TODO(P9)`，卡能发出但按钮无人处理）。只认运营群来源；处理后去掉按钮并盖戳「✅ 已批准 · @谁」，重复点击提示已失效。另补 `bot.catch`，单条 update 出错不再停掉整个轮询。**真机点按钮未验证**：需一个 Phase 1 群产生真实中断
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
