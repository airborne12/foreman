#!/usr/bin/env bash
# 全量测试入口（openlogos verify 的 pre_run_command）。
# 显式使用 nvm 里最新的 Node 24，避免 PATH 中旧 node 执行 corepack 垫片失败。
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_DIR=$(ls -d "$HOME"/.nvm/versions/node/v24* 2>/dev/null | sort -V | tail -1 || true)
if [ -n "${NODE_DIR:-}" ]; then export PATH="$NODE_DIR/bin:$PATH"; fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec ./node_modules/.bin/vitest run "$@"
