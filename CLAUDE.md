# CLAUDE.md

本仓库的开发契约在 [AGENTS.md](./AGENTS.md)，对 Claude Code 同样生效。开始任何改动前先读它，再读 `docs/技术架构设计.md`。

快速命令：`pnpm infra:up`（起 Postgres + Redis）→ `cp .env.example .env` → `pnpm db:generate` → `pnpm check`。
