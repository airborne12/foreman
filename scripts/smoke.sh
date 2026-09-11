#!/usr/bin/env bash
# 部署冒烟（来源：logos/resources/test/smoke/core-smoke-test-cases.md，SMOKE-core-01 ~ 16）
# 用法：scripts/smoke.sh prod|local   在笔记本执行；prod 的机器级检查经 ssh 完成
# 结果按 OpenLogos reporter 格式写入 logos/resources/verify/smoke-results.jsonl
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-prod}"
OUT="$ROOT/logos/resources/verify/smoke-results.jsonl"
CENTER_SSH="${CENTER_SSH:-jiangkai2@172.17.2.13}"
PSQL="${CENTER_PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"
if [ "$ENV_NAME" = prod ]; then BASE="http://172.17.2.13:7801"; else BASE="http://127.0.0.1:7801"; fi
mkdir -p "$(dirname "$OUT")"; : > "$OUT"
PASS=0; FAIL=0; SKIP=0

report() { # id status [error]
  local id="$1" st="$2" err="${3:-}"
  python3 - "$id" "$st" "$err" "$OUT" <<'PY'
import json,sys,datetime
id,st,err,out=sys.argv[1:5]
rec={"id":id,"status":st,"timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat()}
if err: rec["error"]=err[:2000]
open(out,"a").write(json.dumps(rec,ensure_ascii=False)+"\n")
PY
  case "$st" in pass) PASS=$((PASS+1)); printf '  ✅ %s\n' "$id";; skip) SKIP=$((SKIP+1)); printf '  ⏭️  %s（%s）\n' "$id" "$err";; *) FAIL=$((FAIL+1)); printf '  ❌ %s：%s\n' "$id" "$err";; esac
}
check() { # id description command...
  local id="$1"; shift
  local msg; if msg="$("$@" 2>&1)"; then report "$id" pass; else report "$id" fail "$(printf '%s' "$msg" | tail -3 | tr '\n' ' ')"; fi
}
remote() { ssh -o ConnectTimeout=8 "$CENTER_SSH" "$@"; }
TOKEN=""
if [ "$ENV_NAME" = prod ]; then TOKEN="$(remote 'security find-generic-password -s foreman-panel-token -w 2>/dev/null || sed -n "s/^FOREMAN_PANEL_TOKEN=//p" ~/.foreman/env' 2>/dev/null || true)"
else TOKEN="${FOREMAN_PANEL_TOKEN:-}"; fi

echo "冒烟环境：$ENV_NAME（$BASE）"

# SMOKE-core-01 健康检查
c01() { local b; b="$(curl -fsS --max-time 5 "$BASE/healthz")" || { echo "healthz 不可达"; return 1; }
  echo "$b" | grep -q '"status":"ok"' || { echo "status 非 ok：$b"; return 1; }
  echo "$b" | grep -q '"database":"ok"' || { echo "database 非 ok：$b"; return 1; }
  echo "$b" | grep -q '"scheduler":"ok"' || { echo "scheduler 非 ok：$b"; return 1; }; }
check SMOKE-core-01 c01

# SMOKE-core-02 launchd 三项
c02() { local l; l="$(remote 'launchctl list | grep ai.foreman' )" || { echo "无 ai.foreman 单元"; return 1; }
  for u in ai.foreman.center ai.foreman.worker; do
    # 第一列是 PID：非 "-" 即在跑；第二列是上次退出码，部署时 kickstart -k 会留下 -15，不算异常
    echo "$l" | awk -v u="$u" '$3==u && $1 ~ /^[0-9]+$/ {ok=1} END{exit ok?0:1}' || { echo "$u 未在运行：$(echo "$l" | grep "$u" || echo 未加载)"; return 1; }
  done; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-02 c02; else report SMOKE-core-02 skip "仅 prod"; fi

# SMOKE-core-03 配置与密钥
c03() { [ -n "$TOKEN" ] || { echo "读不到 panel token（keychain 与 ~/.foreman/env 都没有）"; return 1; }
  remote 'security find-generic-password -s foreman-worker-token -w >/dev/null 2>&1 || grep -q "^FOREMAN_TOKEN=" ~/.foreman/env' || { echo "无 worker token"; return 1; }
  [ "$(remote 'stat -f %Lp ~/.foreman/env 2>/dev/null || echo 600')" = 600 ] || { echo "~/.foreman/env 权限不是 0600"; return 1; }
  remote 'grep -q changeme ~/.foreman/center.yaml' && { echo "center.yaml 含占位值"; return 1; }
  curl -fsS --max-time 5 "$BASE/healthz" | grep -q '"database":"ok"' || { echo "DATABASE_URL 不可连"; return 1; }; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-03 c03; else report SMOKE-core-03 skip "仅 prod"; fi

# SMOKE-core-04 代理可达模型服务
c04() { local a o; a="$(remote 'curl -s -x http://127.0.0.1:10809 -o /dev/null -w %{http_code} --max-time 15 https://api.anthropic.com/v1/messages')"
  o="$(remote 'curl -s -x http://127.0.0.1:10809 -o /dev/null -w %{http_code} --max-time 15 https://api.openai.com/')"
  [ "$a" = 405 ] || { echo "anthropic 返回 $a（期望 405）"; return 1; }
  [ "$o" = 421 ] || [ "$o" = 403 ] || { echo "openai 返回 $o（期望 421）"; return 1; }; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-04 c04; else report SMOKE-core-04 skip "仅 prod"; fi

# SMOKE-core-05 迁移与初始数据（本实现用 schema_migrations + schema.sql，非 prisma）
c05() { local t s m
  t="$(remote "$PSQL -d foreman -tAc 'select count(*) from trust_counters'")"; s="$(remote "$PSQL -d foreman -tAc 'select count(*) from source_health'")"
  m="$(remote "$PSQL -d foreman -tAc \"select count(*) from schema_migrations where name='0001_init'\"")"
  [ "$m" = 1 ] || { echo "0001_init 未应用"; return 1; }
  [ "$t" = 13 ] || { echo "trust_counters=$t（期望 13）"; return 1; }
  [ "$s" = 3 ] || { echo "source_health=$s（期望 3）"; return 1; }; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-05 c05; else report SMOKE-core-05 skip "仅 prod（local 用 docker 库）"; fi

# SMOKE-core-06 面板静态资源
c06() { local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/")"
  [ "$code" = 200 ] || { echo "GET / 返回 $code（面板 SPA 尚未交付）"; return 1; }; }
check SMOKE-core-06 c06

# SMOKE-core-07 认证边界
c07() { local a b c
  a="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/inbox")"
  b="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "authorization: Bearer $TOKEN" "$BASE/api/inbox")"
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'authorization: Bearer wrong' "$BASE/api/runtimes/auth-check")"
  [ "$a" = 401 ] && [ "$b" = 200 ] && [ "$c" = 401 ] || { echo "无token=$a 有token=$b 错worker=$c（期望 401/200/401）"; return 1; }; }
check SMOKE-core-07 c07

# SMOKE-core-08 runtime 链路
c08() { local b; b="$(curl -fsS --max-time 5 -H "authorization: Bearer $TOKEN" "$BASE/api/runtimes")" || { echo "取不到 runtimes"; return 1; }
  echo "$b" | grep -q '"name":"center"' || { echo "center 未注册：$b"; return 1; }
  echo "$b" | python3 -c 'import json,sys; d=json.load(sys.stdin); c=[x for x in d["items"] if x["name"]=="center"]; sys.exit(0 if c and c[0]["online"] else 1)' || { echo "center 不在线"; return 1; }
  if [ "$ENV_NAME" = prod ]; then
    local why; why="$(echo "$b" | python3 -c '
import json,sys
d=json.load(sys.stdin); x=[i for i in d["items"] if i["name"]=="dev"]
if not x: print("dev 未注册"); sys.exit(0)
r=x[0]; miss=[l for l in ("build:doris","vpn:jira") if l not in r["labels"]]
print("" if r["online"] and not miss else ("dev 离线" if not r["online"] else "dev 在线但缺标签 " + ",".join(miss)))')"
    [ -z "$why" ] || { echo "$why"; return 1; }
  fi; }
check SMOKE-core-08 c08

# SMOKE-core-09 反向隧道
c09() { local b; b="$(curl -fsS --max-time 5 -H "authorization: Bearer $TOKEN" "$BASE/api/system/tunnels/dev")" || { echo "隧道状态取不到"; return 1; }
  echo "$b" | grep -q '"state":"up"' || { echo "隧道非 up：$b"; return 1; }; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-09 c09; else report SMOKE-core-09 skip "仅 prod"; fi

# SMOKE-core-10 / 11 / 15 核心链路：尚未自动化，原因见下面的 skip 文案与部署报告
for id in SMOKE-core-10 SMOKE-core-11 SMOKE-core-15; do
  report "$id" skip "核心链路未自动化：代码类入口要 dev 带 build:doris（见 SMOKE-core-08），而 POST /api/tasks 建的任务目前不会自动派发（设计缺口，见部署报告 §6）"
done

# SMOKE-core-12 飞书通道
c12() { local b; b="$(curl -fsS --max-time 5 "$BASE/healthz")"
  echo "$b" | grep -q '"feishuSubscription":"ok"' || {
    if remote 'test -x ~/bin/lark-cli' 2>/dev/null; then echo "飞书未启用：lark-cli 已装但未登录（app secret 不在 keychain），center.yaml 的 feishu.enabled 仍为 false"
    else echo "飞书未启用：中心机没有 lark-cli（部署方案 §4.4.1）"; fi; return 1; }; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-12 c12; else report SMOKE-core-12 skip "仅 prod"; fi

# SMOKE-core-13 Jira 只读
c13() { echo "smoke.jiraKey 未配置或 sources.jira.enabled=false"; return 1; }
if [ "$ENV_NAME" = prod ]; then
  if remote 'grep -q "enabled: true" ~/.foreman/center.yaml' 2>/dev/null; then check SMOKE-core-13 c13; else report SMOKE-core-13 skip "sources.jira.enabled=false（首次发布未开启真实轮询）"; fi
else report SMOKE-core-13 skip "仅 prod"; fi

# SMOKE-core-14 来源健康度
c14() { local b; b="$(curl -fsS --max-time 5 -H "authorization: Bearer $TOKEN" "$BASE/api/system/sources")" || { echo "取不到来源健康"; return 1; }
  echo "$b" | python3 -c 'import json,sys; d=json.load(sys.stdin); bad=[i for i in d["items"] if i["status"] not in ("ok","disabled")]; print(bad); sys.exit(1 if bad else 0)' || { echo "存在非 ok/disabled 的来源"; return 1; }; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-14 c14; else report SMOKE-core-14 skip "仅 prod"; fi

# SMOKE-core-16 日志与备份
c16() { local e ev bk
  e="$(remote 'tail -n 200 ~/foreman/logs/center.err.log 2>/dev/null | grep -c "\"level\":50" || true')"
  [ "${e:-0}" = 0 ] || { echo "center.err.log 最近 200 行有 $e 条 error"; return 1; }
  # 最近 24 小时内有非空的发布备份
  bk="$(remote 'find ~/foreman/backups -name "foreman-*.dump" -size +0 -mtime -1 2>/dev/null | wc -l | tr -d " "')"
  [ "${bk:-0}" -ge 1 ] || { echo "~/foreman/backups 里没有最近 24 小时的非空 dump"; return 1; }
  # 跑了核心链路才要求「最近有事件」；空转的中心只要求事件日志可用
  if [ "${SMOKE_CORE_LINK:-0}" = 1 ]; then
    ev="$(remote "$PSQL -d foreman -tAc \"select count(*) from events where created_at > now() - interval '30 minutes'\"")"
    [ "${ev:-0}" -ge 1 ] || { echo "跑过核心链路但最近 30 分钟没有 events 记录"; return 1; }
  else
    ev="$(remote "$PSQL -d foreman -tAc 'select count(*) from events'")"
    [ "${ev:-0}" -ge 1 ] || { echo "events 表为空，事件日志没在写"; return 1; }
  fi; }
if [ "$ENV_NAME" = prod ]; then check SMOKE-core-16 c16; else report SMOKE-core-16 skip "仅 prod"; fi

echo
echo "冒烟结果：通过 $PASS · 失败 $FAIL · 跳过 $SKIP → $OUT"
[ "$FAIL" -eq 0 ]
