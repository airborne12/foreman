#!/usr/bin/env bash
# 中心机本机 worker 启动包装（transport: local）
set -euo pipefail
export FOREMAN_HOME="${FOREMAN_HOME:-$HOME/.foreman}"
export FOREMAN_TOKEN="$(security find-generic-password -s foreman-worker-token -w)"
NODE="${FOREMAN_NODE:-/opt/homebrew/bin/node}"
exec "$NODE" "$HOME/foreman/current/apps/worker/dist/foreman-worker.mjs"
