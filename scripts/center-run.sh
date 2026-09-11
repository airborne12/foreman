#!/usr/bin/env bash
# center 启动包装：token 从 keychain 读出后注入环境，不写进 plist（来源：部署方案 §3.1、§4.2）
set -euo pipefail
export FOREMAN_HOME="${FOREMAN_HOME:-$HOME/.foreman}"
# token 优先读 keychain；非交互会话读不到时退回 0600 的 EnvironmentFile（部署方案 §3.4 允许两者之一）
if security find-generic-password -s foreman-panel-token -w >/dev/null 2>&1; then
  export FOREMAN_TOKEN="$(security find-generic-password -s foreman-worker-token -w)"
  export FOREMAN_PANEL_TOKEN="$(security find-generic-password -s foreman-panel-token -w)"
else
  set -a; . "$FOREMAN_HOME/env"; set +a
fi
NODE="${FOREMAN_NODE:-/opt/homebrew/bin/node}"
exec "$NODE" "$HOME/foreman/current/apps/center/dist/center.mjs"
