#!/bin/zsh
# 停止并移除两个常驻进程。不删日志。
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
for s in bot worker; do
  label="com.matchbot.$s"
  launchctl bootout "gui/$UID/$label" 2>/dev/null && echo "✓ $label 已停止" || echo "· $label 未在运行"
  rm -f "$AGENTS/$label.plist"
done
echo "已移除。日志保留在 logs/。"
