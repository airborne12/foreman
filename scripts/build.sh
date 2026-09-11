#!/usr/bin/env bash
# 构建单文件产物（来源：core-01-deployment-plan.md §4.1）
# center → apps/center/dist/center.mjs；worker → apps/worker/dist/foreman-worker.mjs；cli → apps/cli/dist/foreman.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Node 24+：优先用 nvm 里最新的 v24，其次用 PATH 上的 node
NODE_DIR="$(ls -d "$HOME"/.nvm/versions/node/v24* 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$NODE_DIR" ] && export PATH="$NODE_DIR/bin:$PATH"
BANNER="import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);"

build_one() {
  local app="$1" out="$2"
  mkdir -p "apps/$app/dist"
  ./node_modules/.bin/esbuild "apps/$app/src/index.ts" \
    --bundle --platform=node --target=node22 --format=esm \
    --outfile="apps/$app/dist/$out" \
    --external:pg-native --external:cpu-features --external:bufferutil --external:utf-8-validate \
    --banner:js="$BANNER" --log-level=warning
  printf '  %-22s %s\n' "$out" "$(du -h "apps/$app/dist/$out" | cut -f1)"
}

echo "构建面板 SPA（apps/panel → apps/center/public）"
( cd "$ROOT/apps/panel" && ./node_modules/.bin/vite build 2>&1 | tail -4 )

echo "构建产物："
build_one center center.mjs
build_one worker foreman-worker.mjs
build_one cli foreman.mjs
