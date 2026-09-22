# 本机部署（macOS launchd）

Phase 0 不对外提供网站，只要 bot 常驻并连通 Telegram，worker 常驻消费队列。用 macOS 原生的
launchd，不额外引入 Docker 或 pm2。

## 安装

```bash
pnpm infra:up                      # Postgres（+ Redis，见下方注意）
pnpm db:generate && pnpm --filter @matchbot/db exec prisma migrate deploy
./deploy/local/install.sh --build  # 构建 + 安装 + 启动
```

安装脚本会：校验 `.env` 与构建产物存在 → 把仓库路径和 `node` 绝对路径渲染进 plist →
`plutil -lint` 校验格式 → `launchctl bootstrap` 加载 → 打印两个服务的 state 与 pid。
重复执行是幂等的（先 `bootout` 再 `bootstrap`）。

## 运维

```bash
tail -f logs/worker.log                          # pino JSON 行
launchctl print gui/$UID/com.matchbot.bot        # 状态、pid、退出码
launchctl kickstart -k gui/$UID/com.matchbot.bot # 强制重启单个服务
./deploy/local/uninstall.sh                      # 停止并移除（保留日志）
```

改了代码后：`pnpm build && launchctl kickstart -k gui/$UID/com.matchbot.{bot,worker}`。

## 已验证

- 崩溃自动拉起：`kill -9` bot 进程后 15s 内被 launchd 重新拉起，pid 变化，`logs/bot.log`
  里能看到第二条 `bot started`（`KeepAlive` + `ThrottleInterval=10`）。
- 日志落盘：stdout / stderr 分别进 `logs/<svc>.log` 与 `logs/<svc>.err.log`。

## 注意

**1. node 路径被钉死在 plist 里。** 本机 node 来自 nvm，launchd 不经过 nvm，所以安装时把
当时的绝对路径写进了 plist。`nvm use` 换版本后必须重跑 `install.sh`。

**2. 同一个 bot token 只能有一个长轮询。** launchd 里的 bot 跑起来之后，不要再跑
`pnpm dev:bot` 或 PoC V5 的监听脚本，否则 Telegram 返回 409 Conflict。调试前先
`launchctl bootout gui/$UID/com.matchbot.bot`。

**3. Redis 用的不是 compose 那个。** 本机有一个 Homebrew 的 `redis-server` 常驻在
`127.0.0.1:6379`，而 compose 起的容器绑 `*:6379`；`localhost` 解析到 127.0.0.1，所以应用
实际连的是 Homebrew 那个，容器 Redis 始终空转。目前能正常工作，但版本与持久化配置都没钉死。
要统一到 compose：`brew services stop redis` 后重跑 `pnpm infra:up`。见
`plan/P13-phase0-launch.md` §C+.2。

**4. 日志不会自动轮转。** Phase 0 量小（只听不说），先观察增长速度；需要时用 macOS 自带的
`newsyslog` 加一条规则，或在 cron 里按天切分。

**5. 合盖睡眠会暂停进程。** 笔记本部署的固有限制：睡眠期间收不到消息，醒来后 grammY 会重连、
BullMQ 的 repeatable job 也会补跑。Phase 0 可以接受；长期常驻应考虑换一台不休眠的机器。
