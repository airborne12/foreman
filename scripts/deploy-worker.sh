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
    ssh "$DEV_SSH" 'mkdir -p ~/.foreman/bin ~/.config/systemd/user && chmod 700 ~/.foreman'
    scp -q "$SRC" "$DEV_SSH:.foreman/bin/foreman-worker.mjs.new"
    scp -q "$ROOT/scripts/systemd/foreman-worker.service" "$DEV_SSH:.config/systemd/user/foreman-worker.service"
    ssh "$DEV_SSH" 'set -e
      cd ~/.foreman/bin
      [ -f foreman-worker.mjs ] && mv foreman-worker.mjs foreman-worker.mjs.prev
      mv foreman-worker.mjs.new foreman-worker.mjs
      systemctl --user daemon-reload
      systemctl --user enable --now foreman-worker >/dev/null 2>&1 || systemctl --user restart foreman-worker
      sleep 3; systemctl --user is-active foreman-worker'
    ;;
  center)
    ssh "${CENTER_SSH:-jiangkai2@172.17.2.13}" 'launchctl kickstart -k gui/$(id -u)/ai.foreman.worker && sleep 2 && echo restarted' ;;
  laptop)
    echo "笔记本：foreman worker init 后由 launchd 保活（本批未自动化）" ;;
  *) echo "未知 runtime：$RT"; exit 2 ;;
esac
