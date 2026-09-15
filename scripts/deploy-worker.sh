#!/usr/bin/env bash
# worker 发布（在笔记本执行）：把单文件 bundle 送到目标 runtime 并重启
# 来源：core-01-deployment-plan.md §4.3
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT="${1:?用法：deploy-worker.sh dev|center|laptop}"
SRC="$ROOT/apps/worker/dist/foreman-worker.mjs"
[ -f "$SRC" ] || bash "$ROOT/scripts/build.sh"
case "$RT" in
  dev)
    DEV_SSH="${DEV_SSH:-jiangkai@10.26.20.3}"
    CENTER_SSH="${CENTER_SSH:-jiangkai2@172.17.2.13}"
    ssh "$DEV_SSH" 'mkdir -p ~/.foreman/bin ~/.config/systemd/user && chmod 700 ~/.foreman'
    # 首次部署：同步 token 与 worker.yaml（已存在则保留）
    TOKEN="$(ssh "$CENTER_SSH" 'sed -n "s/^FOREMAN_TOKEN=//p" ~/.foreman/env')"
    [ -n "$TOKEN" ] || { echo "读不到中心的 FOREMAN_TOKEN"; exit 1; }
    ssh "$DEV_SSH" "bash -s '$TOKEN'" <<'REMOTE'
set -euo pipefail
TOKEN="$1"
if [ ! -f ~/.foreman/env ]; then printf 'FOREMAN_TOKEN=%s\n' "$TOKEN" > ~/.foreman/env; chmod 600 ~/.foreman/env; echo "~/.foreman/env 已生成"; else echo "~/.foreman/env 已存在，保留"; fi
if [ ! -f ~/.foreman/worker.yaml ]; then
  cat > ~/.foreman/worker.yaml <<'YAML'
name: dev
center:
  url: ws://127.0.0.1:7801      # 经中心机 ssh -R 反向隧道
  token: ${FOREMAN_TOKEN}
transport: reverse-tunnel
labels: [agent:claude, agent:codex, vpn:jira]
agents:
  claude: { bin: claude, maxConcurrent: 3 }
  codex: { bin: codex, maxConcurrent: 3 }
# 代码类任务需要在这里登记 Doris 克隆与 worktree 根目录，例如：
# repos:
#   selectdb/selectdb-core: { main: /mnt/disk11/jiangkai/selectdb-core, worktreeRoot: /mnt/disk11/jiangkai/foreman-wt }
# 并在 labels 里加 build:doris 与 repo:selectdb/selectdb-core
repos: {}
capabilities: [jira-poll, jira-lookup, gh]
worktree:
  retain_days: 3
  disk_high_watermark: 0.85
YAML
  chmod 600 ~/.foreman/worker.yaml; echo "worker.yaml 已生成（未登记仓库，代码类任务暂不路由到 dev）"
else echo "worker.yaml 已存在，保留"; fi
REMOTE
    scp -q "$SRC" "$DEV_SSH:.foreman/bin/foreman-worker.mjs.new"
    scp -q "$ROOT/scripts/systemd/foreman-worker.service" "$DEV_SSH:.config/systemd/user/foreman-worker.service"
    ssh "$DEV_SSH" 'set -e
      export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
      cd ~/.foreman/bin
      [ -f foreman-worker.mjs ] && mv foreman-worker.mjs foreman-worker.mjs.prev
      mv foreman-worker.mjs.new foreman-worker.mjs
      systemctl --user daemon-reload
      systemctl --user enable foreman-worker >/dev/null 2>&1; systemctl --user restart foreman-worker   # enable --now 不会重启已在运行的旧进程
      sleep 3; systemctl --user is-active foreman-worker'
    ;;
  center)
    ssh "${CENTER_SSH:-jiangkai2@172.17.2.13}" 'launchctl kickstart -k gui/$(id -u)/ai.foreman.worker && sleep 2 && echo restarted' ;;
  laptop)
    echo "笔记本：foreman worker init 后由 launchd 保活（本批未自动化）" ;;
  *) echo "未知 runtime：$RT"; exit 2 ;;
esac
