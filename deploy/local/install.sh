#!/bin/zsh
# 本机部署 matchbot 的 bot 与 worker 两个常驻进程（macOS launchd）。
# 用法：./deploy/local/install.sh          安装并启动
#       ./deploy/local/install.sh --build  先构建再安装
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
SERVICES=(bot worker)

[[ -f "$REPO/.env" ]] || { echo "✗ 缺少 $REPO/.env"; exit 1; }
[[ -n "$NODE" ]] || { echo "✗ 找不到 node"; exit 1; }

# launchd 用的是绝对路径且不经 nvm，node 换版本后必须重装；这里把当时的路径钉进 plist。
echo "repo = $REPO"
echo "node = $NODE ($($NODE -v))"

if [[ "${1:-}" == "--build" ]]; then
  echo "→ pnpm build"
  (cd "$REPO" && pnpm build)
fi

for s in $SERVICES; do
  [[ -f "$REPO/apps/$s/dist/main.js" ]] || {
    echo "✗ 缺少 apps/$s/dist/main.js，先跑 pnpm build（或用 --build）"; exit 1; }
done

mkdir -p "$REPO/logs" "$AGENTS"

for s in $SERVICES; do
  label="com.matchbot.$s"
  plist="$AGENTS/$label.plist"
  sed -e "s#__REPO__#$REPO#g" -e "s#__NODE__#$NODE#g" \
    "$REPO/deploy/local/$label.plist.template" > "$plist"
  plutil -lint "$plist" >/dev/null || { echo "✗ $label.plist 格式非法"; exit 1; }
  # bootout 幂等：已加载就先卸载，未加载时忽略报错
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$plist"
  echo "✓ $label 已加载"
done

sleep 3
echo
echo "=== 状态 ==="
for s in $SERVICES; do
  label="com.matchbot.$s"
  # print 的输出很长，只取 state 与 pid
  launchctl print "gui/$UID/$label" 2>/dev/null \
    | awk -v l="$label" '/^\tstate = /{st=$3} /^\tpid = /{pid=$3} END{printf "  %-22s state=%s pid=%s\n", l, st, (pid?pid:"-")}'
done
echo
echo "日志：$REPO/logs/{bot,worker}.log（pino JSON 行）"
echo "查看：tail -f $REPO/logs/worker.log | $REPO/node_modules/.bin/pino-pretty  # 若已装 pino-pretty"
echo "卸载：./deploy/local/uninstall.sh"
