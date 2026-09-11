#!/usr/bin/env bash
# 中心发布（在笔记本执行）：构建 → rsync 到中心机 release → 备份 → 切 current → 重启 launchd
# 来源：core-01-deployment-plan.md §4.2、§5；偏离见 implementation-manifest.md（无 git remote，改为 rsync 工作树）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CENTER_SSH="${CENTER_SSH:-jiangkai2@172.17.2.13}"
PSQL="${CENTER_PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"
PGDUMP="${CENTER_PGDUMP:-/opt/homebrew/opt/postgresql@17/bin/pg_dump}"
TS="$(date +%Y%m%d%H%M%S)"
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

say "1/7 构建单文件产物"
bash "$ROOT/scripts/build.sh"

say "2/7 准备中心机目录（~/foreman/{releases,logs,backups} 与 ~/.foreman）"
ssh "$CENTER_SSH" "mkdir -p ~/foreman/releases/$TS ~/foreman/logs ~/foreman/backups ~/.foreman && chmod 700 ~/.foreman"

say "3/7 首次部署：生成 token、建库与配置（已存在则跳过）"
ssh "$CENTER_SSH" "PSQL='$PSQL' bash -s" <<'REMOTE'
set -euo pipefail
gen() { LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64; }
# 非交互 ssh 会话写不了 keychain，改用 0600 的 EnvironmentFile（部署方案 §3.4 允许）
if [ ! -f ~/.foreman/env ]; then
  printf 'FOREMAN_TOKEN=%s\nFOREMAN_PANEL_TOKEN=%s\n' "$(gen)" "$(gen)" > ~/.foreman/env
  chmod 600 ~/.foreman/env; echo "~/.foreman/env 已生成（两枚 token，0600）"
else echo "~/.foreman/env 已存在，保留"; fi
if ! "$PSQL" -lqt 2>/dev/null | cut -d'|' -f1 | tr -d ' ' | grep -qx foreman; then
  "${PSQL%psql}createdb" foreman && echo "postgres: 数据库 foreman 已创建"
else echo "postgres: 数据库 foreman 已存在"; fi
if [ ! -f ~/.foreman/center.yaml ]; then
  cat > ~/.foreman/center.yaml <<YAML
listen: 0.0.0.0:7801
database: postgres://$USER@127.0.0.1:5432/foreman
token: \${FOREMAN_TOKEN}
panel_token: \${FOREMAN_PANEL_TOKEN}
proxy: http://127.0.0.1:10809
feishu:
  enabled: false          # lark-cli 未安装，见部署方案 §4.4.1
  owner_open_id: ""
  bot_open_id: ""
sources:
  jira:
    enabled: false        # 首次发布先不自动轮询真实 Jira，确认无误后再打开
    run_on_label: vpn:jira
    project_repo_map:
      CIR: selectdb/selectdb-core
  feishu:
    scan_enabled: false
tunnels:
  dev:
    ssh: jiangkai@10.26.20.3
    remote_port: 7801
    local_port: 7801
YAML
  chmod 600 ~/.foreman/center.yaml; echo "center.yaml 已生成"
else echo "center.yaml 已存在，保留"; fi
if [ ! -f ~/.foreman/worker.yaml ]; then
  cat > ~/.foreman/worker.yaml <<YAML
name: center
center:
  url: ws://127.0.0.1:7801
  token: \${FOREMAN_TOKEN}
transport: local
labels: [agent:claude, agent:codex, text]
agents:
  claude: { bin: claude, maxConcurrent: 3 }
  codex: { bin: codex, maxConcurrent: 3 }
repos: {}
capabilities: []
YAML
  chmod 600 ~/.foreman/worker.yaml; echo "worker.yaml（中心机 runtime）已生成"
else echo "worker.yaml 已存在，保留"; fi
REMOTE

say "4/7 同步 release 到中心机"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude 'logs' \
  "$ROOT/" "$CENTER_SSH:foreman/releases/$TS/"

say "5/7 迁移前备份（库为空时跳过）"
ssh "$CENTER_SSH" "if $PSQL -d foreman -tAc \"select count(*) from information_schema.tables where table_schema='public'\" | grep -qv '^0$'; then $PGDUMP -Fc -h 127.0.0.1 foreman > ~/foreman/backups/foreman-$TS.dump && echo '备份 ~/foreman/backups/foreman-$TS.dump'; else echo '库为空，跳过备份'; fi"

say "6/7 切换 current 并装载 launchd 单元"
ssh "$CENTER_SSH" "bash -s $TS" <<'REMOTE'
set -euo pipefail
TS="$1"; H="$HOME"
ln -sfn "$H/foreman/releases/$TS" "$H/foreman/current"
mkdir -p "$H/Library/LaunchAgents"
# 隧道不再单独用 launchd：由中心的 TunnelManager 拉起并保活（状态见 /api/system/tunnels）
for u in ai.foreman.center ai.foreman.worker; do
  sed "s|__HOME__|$H|g" "$H/foreman/current/scripts/launchd/$u.plist" > "$H/Library/LaunchAgents/$u.plist"
done
UID_N="$(id -u)"
launchctl bootout "gui/$UID_N/ai.foreman.tunnel.dev" 2>/dev/null || true
for u in ai.foreman.center ai.foreman.worker; do
  launchctl bootstrap "gui/$UID_N" "$H/Library/LaunchAgents/$u.plist" 2>/dev/null || true
  launchctl kickstart -k "gui/$UID_N/$u" >/dev/null 2>&1 || true
done
echo "current → $(readlink "$H/foreman/current")"
REMOTE

say "7/7 等待 healthz"
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://172.17.2.13:7801/healthz" >/dev/null 2>&1; then break; fi; sleep 2
done
curl -fsS --max-time 5 "http://172.17.2.13:7801/healthz" || { echo "healthz 未通过，见中心机 ~/foreman/logs/center.err.log"; exit 1; }
echo
ssh "$CENTER_SSH" "echo \"DEPLOY $TS\" >> ~/foreman/deploy.log; ls -dt ~/foreman/releases/* | tail -n +6 | xargs -r rm -rf"
echo "发布完成：$TS"
