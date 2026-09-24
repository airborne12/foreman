#!/usr/bin/env bash
# 实验环境（在中心机上运行）：独立库 + 真实时钟的中心 + 模拟 worker，不碰生产、不耗 agent 额度。
#   - 库：foreman_uxlab（LAB_RESET=1 时重建）
#   - 中心：127.0.0.1:7899，只绑回环地址；飞书关闭；Jira 轮询交给模拟 worker 回应
#   - 退出（包括 ssh 断开）时一并收掉两个进程
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

DB="${LAB_DB:-foreman_uxlab}"
PORT="${LAB_PORT:-7899}"
if [ "${LAB_RESET:-0}" = "1" ]; then dropdb --if-exists "$DB"; fi
createdb "$DB" 2>/dev/null || true

CFG="$(mktemp -t foreman-lab).yaml"
cat > "$CFG" <<EOF
listen: 127.0.0.1:${PORT}
database: postgres://${USER}@127.0.0.1:5432/${DB}
token: lab-worker-token
panel_token: lab-panel-token
feishu: { enabled: false }
sources:
  jira: { enabled: true, poll_seconds: ${LAB_POLL_SECONDS:-40}, run_on_label: "vpn:jira", project_repo_map: { CIR: selectdb/selectdb-core } }
EOF

C=""; W=""
cleanup() { [ -n "$W" ] && kill "$W" 2>/dev/null; [ -n "$C" ] && kill "$C" 2>/dev/null; rm -f "$CFG"; }
trap cleanup EXIT INT TERM HUP

FOREMAN_CENTER_CONFIG="$CFG" node --import tsx apps/center/src/index.ts &
C=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break; sleep 1; done
echo "lab center ready on :${PORT}"

LAB_CENTER="http://127.0.0.1:${PORT}" node --import tsx scripts/lab/sim-worker.ts &
W=$!
wait
