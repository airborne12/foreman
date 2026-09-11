#!/usr/bin/env bash
# 中心机本机 worker 启动包装（transport: local）
set -euo pipefail
export FOREMAN_HOME="${FOREMAN_HOME:-$HOME/.foreman}"
if security find-generic-password -s foreman-worker-token -w >/dev/null 2>&1; then
  export FOREMAN_TOKEN="$(security find-generic-password -s foreman-worker-token -w)"
else
  set -a; . "$FOREMAN_HOME/env"; set +a
fi
NODE="${FOREMAN_NODE:-/opt/homebrew/bin/node}"
exec "$NODE" "$HOME/foreman/current/apps/worker/dist/foreman-worker.mjs"
