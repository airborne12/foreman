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
    # worker 的家目录以 systemd 用户实例为准，不能用 ssh 登录后的 ~：2026-09-29 账号 home 从 /mnt/disk1 迁到
    # /mnt/disk14，ssh 进去的 ~ 变了而在跑的 worker 还在老目录，两次发布都落空、跑的仍是旧版
    # 优先取 worker 单元里写死的 HOME（WORKER_HOME 可显式指定），其次 systemd 实例的 HOME，最后 ssh 的 ~
    WHOME="${WORKER_HOME:-$(ssh "$DEV_SSH" 'systemctl --user show foreman-worker -p Environment --value 2>/dev/null | tr " " "\n" | sed -n "s/^HOME=//p"')}"
    [ -n "$WHOME" ] || WHOME="$(ssh "$DEV_SSH" 'systemctl --user show-environment 2>/dev/null | sed -n "s/^HOME=//p"')"
    [ -n "$WHOME" ] || WHOME="$(ssh "$DEV_SSH" 'echo $HOME')"
    echo "worker 家目录：$WHOME"
    ssh "$DEV_SSH" "mkdir -p '$WHOME/.foreman/bin' '$WHOME/.config/systemd/user' && chmod 700 '$WHOME/.foreman'"
    # 首次部署：同步 token 与 worker.yaml（已存在则保留）
    TOKEN="$(ssh "$CENTER_SSH" 'sed -n "s/^FOREMAN_TOKEN=//p" ~/.foreman/env')"
    [ -n "$TOKEN" ] || { echo "读不到中心的 FOREMAN_TOKEN"; exit 1; }
    # agent 走订阅版 CLI 要出网，而 systemd --user 不读 ~/.bashrc：代理必须进 EnvironmentFile，
    # 否则 codex 连 chatgpt.com 直接 403（缺省沿用中心 center.yaml 的 proxy，可用 WORKER_PROXY 覆盖）
    PROXY="${WORKER_PROXY:-$(ssh "$CENTER_SSH" 'sed -n "s/^proxy: *//p" ~/.foreman/center.yaml' | head -1)}"
    ssh "$DEV_SSH" "HOME='$WHOME' bash -s '$TOKEN' '$PROXY'" <<'REMOTE'
set -euo pipefail
TOKEN="$1"
PROXY="${2:-}"
if [ ! -f ~/.foreman/env ]; then
  printf 'FOREMAN_TOKEN=%s\n' "$TOKEN" > ~/.foreman/env
  [ -n "$PROXY" ] && printf 'HTTP_PROXY=%s\nHTTPS_PROXY=%s\nNO_PROXY=127.0.0.1,localhost\n' "$PROXY" "$PROXY" >> ~/.foreman/env
  chmod 600 ~/.foreman/env; echo "~/.foreman/env 已生成"
else
  echo "~/.foreman/env 已存在，保留"
  grep -q '^HTTPS_PROXY=' ~/.foreman/env || echo "  提醒：env 里没有代理，codex 可能连不上外网（见部署报告第 8 条）"
fi
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
    scp -q "$SRC" "$DEV_SSH:$WHOME/.foreman/bin/foreman-worker.mjs.new"
    # 单元按 worker 家目录渲染；装进 systemd 当前实例读取的单元目录（它的 HOME 可能与 worker 的不同）
    UNIT_DIR="$(ssh "$DEV_SSH" 'echo "$(systemctl --user show-environment 2>/dev/null | sed -n "s/^HOME=//p")/.config/systemd/user"')"
    sed "s|__HOME__|$WHOME|g" "$ROOT/scripts/systemd/foreman-worker.service" | ssh "$DEV_SSH" "mkdir -p '$UNIT_DIR' && cat > '$UNIT_DIR/foreman-worker.service'"
    # 机器重启 / 重新登录后 systemd 实例的 HOME 会变成账号当前 home：在 worker 家目录下也放一份并启用，重启后照样拉起
    if [ "$UNIT_DIR" != "$WHOME/.config/systemd/user" ]; then
      ssh "$DEV_SSH" "d='$WHOME/.config/systemd/user'; mkdir -p \$d/default.target.wants && cp '$UNIT_DIR/foreman-worker.service' \$d/ && ln -sfn ../foreman-worker.service \$d/default.target.wants/foreman-worker.service"
    fi
    ssh "$DEV_SSH" "cd '$WHOME/.foreman/bin' && md5sum foreman-worker.mjs.new | cut -c1-32" | grep -qx "$(md5 -q "$SRC" 2>/dev/null || md5sum "$SRC" | cut -c1-32)" || { echo "新 bundle 校验不一致"; exit 1; }
    ssh "$DEV_SSH" 'set -e
      export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
      cd '"'$WHOME'"'/.foreman/bin
      [ -f foreman-worker.mjs ] && mv foreman-worker.mjs foreman-worker.mjs.prev
      mv foreman-worker.mjs.new foreman-worker.mjs
      systemctl --user daemon-reload
      systemctl --user enable foreman-worker >/dev/null 2>&1; systemctl --user restart foreman-worker   # enable --now 不会重启已在运行的旧进程
      sleep 3; systemctl --user is-active foreman-worker'
    # 发布后自检：systemd 实际跑的 bundle 必须就是刚构建的这一个
    RUNNING="$(ssh "$DEV_SSH" 'f=$(systemctl --user show foreman-worker -p ExecStart --value | grep -o "/[^ ;]*foreman-worker\.mjs" | head -1); md5sum "$f" | cut -c1-32; echo "$f" >&2')"
    [ "$RUNNING" = "$(md5 -q "$SRC" 2>/dev/null || md5sum "$SRC" | cut -c1-32)" ] && echo "自检通过：在跑的就是本次构建" || { echo "自检失败：systemd 在跑的不是本次构建"; exit 1; }
    ;;
  center)
    ssh "${CENTER_SSH:-jiangkai2@172.17.2.13}" 'launchctl kickstart -k gui/$(id -u)/ai.foreman.worker && sleep 2 && echo restarted' ;;
  laptop)
    echo "笔记本：foreman worker init 后由 launchd 保活（本批未自动化）" ;;
  *) echo "未知 runtime：$RT"; exit 2 ;;
esac
