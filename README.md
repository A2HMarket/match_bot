# London Matching Bot

伦敦本地生活 Telegram 群里的供需撮合 Bot。群聊提供实时需求，供应商库与群内同伴提供供给，AI 负责理解、结构化、匹配和引荐。第一阶段不碰支付与履约。

## 文档

| 文档                                                                                       | 内容                                           |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [docs/support-agent-产品需求.md](docs/support-agent-产品需求.md)                           | 产品需求 v2.0                                  |
| [docs/London_Matching_Bot_Project_Brief.docx](docs/London_Matching_Bot_Project_Brief.docx) | 商业逻辑、供应商种子、群种子、两周计划         |
| [docs/技术架构设计.md](docs/技术架构设计.md)                                               | 技术架构 v1.0                                  |
| [docs/reference/](docs/reference/)                                                         | harness 选型对比、Jev、dsh 资料                |
| [AGENTS.md](AGENTS.md)                                                                     | 团队开发契约（所有贡献者必读）                 |
| [plan/README.md](plan/README.md)                                                           | 实施计划看板与各工作包计划（项目跟进的事实源） |

## 技术栈

OpenAI Agents SDK（TS）· deepseek-flash · Jev · grammY · Postgres + Prisma · BullMQ + Redis · pnpm monorepo

## 起步

```sh
nvm use                    # Node 22
pnpm install
pnpm infra:up              # Postgres 17 + Redis 7
cp .env.example .env       # 填入 DEEPSEEK_API_KEY / JEV_API_KEY / TELEGRAM_BOT_TOKEN
pnpm db:generate
pnpm db:migrate            # 首次会创建迁移
pnpm check                 # typecheck + lint + format + test
pnpm dev:bot               # 另一个终端 pnpm dev:worker
```

## 目录

```
apps/       bot（Telegram 进程）· worker（队列消费）· admin（Phase 2）
packages/   shared · domain · db · queue · jev · gating · matcher · channel-telegram · approval · agent · eval
docs/       需求、架构、参考资料
plan/       实施计划看板、跨包接口契约、P0–P13 工作包计划
scripts/    check-deps（依赖方向校验）· poc（架构 §11 的验证脚本）
```

包职责与依赖方向见 AGENTS.md §3。
