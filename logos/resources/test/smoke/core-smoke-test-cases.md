# core: 部署后冒烟测试用例

> 输入：`3-deployment/core-01-deployment-plan.md` 第七节（部署后检查清单）与第八节（冒烟测试方案）
> 执行：`scripts/smoke.sh <env>`，每条用例结果按 `logos/spec/test-results.md` 格式写入 `logos/resources/verify/smoke-results.jsonl`（`id` 为 SMOKE-core-NN）
> 原则：只读或使用带 `smoke` 标记的测试对象；不触碰真实 Jira 单与真实飞书群；prod 上运行前确认无运行中会话

## 一、冒烟测试范围

| 环境 | 覆盖范围 | 说明 |
|------|----------|------|
| local | 健康检查、迁移、静态资源、认证、runtime 链路（本机 worker）、核心链路（文本类）、面板推送 | `pnpm dev` 后自测；飞书与 Jira 项跳过（skip） |
| prod | 全部 16 项 | 每次发布与回滚后必跑；Gate 3.8 依据 |

## 二、冒烟测试用例

| ID | 描述 | 来源 | 目标环境 | 前置条件 | 操作 | 预期结果 |
|----|------|------|----------|----------|------|----------|
| SMOKE-core-01 | 健康检查接口 | 检查清单 #1；smoke 方案「健康检查」 | local, prod | center 已启动 | `curl -s http://127.0.0.1:7801/healthz` | 200；`status` 为 ok；`checks.database` ok；`checks.scheduler` ok |
| SMOKE-core-02 | 进程守护三项在线 | 检查清单 #2 | prod | launchd 单元已加载 | `launchctl list \| grep ai.foreman` | center、worker、tunnel.dev 三项 PID 非空且 status 0 |
| SMOKE-core-03 | 配置与密钥可读 | smoke 方案「配置与密钥」 | prod | keychain 有两枚 token | `foreman center status --json` | `panelToken`、`workerToken` 为 present；`databaseUrl` 可连；无占位值（不含 "changeme"） |
| SMOKE-core-04 | 出网代理可达模型服务 | smoke 方案「配置与密钥」；前置项 5 | prod | sing-box 10809 在跑 | `curl -x http://127.0.0.1:10809 -o /dev/null -w %{http_code} https://api.anthropic.com/v1/messages`；同法 `https://api.openai.com/` | 405；421 |
| SMOKE-core-05 | 数据库迁移与初始数据 | 检查清单 #6；smoke 方案「数据库迁移」 | local, prod | migrate deploy 已跑 | `pnpm prisma migrate status`；`psql -c "select count(*) from trust_counters"`；`select count(*) from source_health` | 无 pending；13；3 |
| SMOKE-core-06 | 面板静态资源 | 检查清单 #3；smoke 方案「静态资源」 | local, prod | 构建产物在 center/public | `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:7801/`；解析 HTML 中首个 `/assets/*.js` 再 GET | 200 且 body 含 `<title>foreman`；JS 200 且 content-type 含 javascript |
| SMOKE-core-07 | 认证边界 | smoke 方案「认证」 | local, prod | — | 无 token `GET /api/inbox`；带 panelToken；错误 workerToken `POST /api/runtimes/auth-check` | 401；200；401 |
| SMOKE-core-08 | runtime 链路 | 检查清单 #4、#5；smoke 方案「runtime 链路」 | local（仅 center/laptop）, prod | worker 已启动 | `GET /api/runtimes` | prod：center 与 dev online，dev.labels 含 build:doris 与 vpn:jira；local：本机 runtime online |
| SMOKE-core-09 | 反向隧道 | 检查清单 #5；smoke 方案「隧道」 | prod | tunnel.dev 已加载 | `foreman center tunnel dev status --json` | `state` up；`reconnects` 为整数 |
| SMOKE-core-10 | 核心链路（文本类，中心机） | smoke 方案「核心链路（文本类）」 | local, prod | 中心机 runtime 在线；claude 或 codex 已登录 | `POST /api/tasks {source:"smoke: 写一句话", path:"plan", kind:"text", channel:"smoke"}` → 轮询任务 → 等待收件箱审批 → `POST /api/approvals/{key}/decide {decision:"reject", bodyHash}` | 任务 runtime = center；60 秒内线程有 ≥1 条 progress；收件箱出现该任务的 triage_confirm 审批；reject 后任务 paused；任务带 smoke 标记 |
| SMOKE-core-11 | 核心链路（代码类只读，开发机） | smoke 方案「核心链路（代码类）」 | prod | dev 在线；selectdb-core 克隆存在 | `POST /api/tasks {source:"smoke: 定位 NGramIndexReader", repo:"selectdb/selectdb-core", path:"plan", kind:"code", channel:"smoke"}` → 等分流卡 → reject | 任务 runtime = dev；worktrees 有 ready 行且路径在 worktreeRoot 下；分流卡 codeLocations ≥ 1（证明 MCP 经隧道回写）；reject 后 paused；worktree 3 天后由 gc 清理 |
| SMOKE-core-12 | 飞书通道 | 检查清单 #7；smoke 方案「飞书」 | prod | lark-cli 机器人已登录 | `foreman center status --json` 的 feishu 段；`POST /api/system/smoke/feishu-ping`（发 `[smoke] <ts>` 到 owner 私聊） | 事件订阅 connected；notifications 该条 status sent 且 external_message_id 非空 |
| SMOKE-core-13 | Jira 只读查询 | smoke 方案「Jira（只读）」 | prod | dev 在线 vpn:jira；配置 `smoke.jiraKey` | `POST /api/system/smoke/jira-lookup {key}` | jobs jira-lookup succeeded；返回 found=true |
| SMOKE-core-14 | 来源健康度 | 检查清单 #8 | prod | 首次轮询已完成 | `GET /api/system/sources` | jira 与 feishu status ok；github ok 或 disabled（M1 未启用则 disabled 可接受） |
| SMOKE-core-15 | 面板实时推送 | smoke 方案「面板推送」 | local, prod | — | 建 `/ws/panel` 连接后执行 SMOKE-core-10 | 5 秒内收到 `inbox.new`（itemType approval）与 `task.updated` |
| SMOKE-core-16 | 日志与备份 | 检查清单 #9、#10；smoke 方案「日志与监控」 | prod | 本次发布完成 | `grep -c '"level":50' ~/foreman/logs/center.err.log`（pino error）；`ls -la ~/foreman/backups/`；`select count(*) from events where created_at > now() - interval '5 minutes'` | 最近 200 行 error 计数 0；本次发布的 dump 存在且 > 0 字节；events 计数 ≥ 1 |

`POST /api/system/smoke/*` 两个端点只在 `center.yaml` 的 `smoke.enabled=true` 时注册，且需 panelToken；它们不在 M1 面板功能范围内，属于部署方案要求的运维辅助接口，实现阶段一并交付。

## 三、覆盖度校验

- [x] 健康检查：SMOKE-core-01、02
- [x] 核心入口：SMOKE-core-06（面板）、07（API 认证）
- [x] 数据库迁移：SMOKE-core-05
- [x] 静态资源：SMOKE-core-06
- [x] 配置与密钥：SMOKE-core-03、04
- [x] 关键链路：SMOKE-core-10、11、15
- [x] 外部通道：SMOKE-core-12（飞书）、13（Jira）、14（健康度）
- [x] 日志与监控：SMOKE-core-16
- [x] 部署后检查清单 #1–#10 每项至少一条 SMOKE 覆盖

## 四、结果记录格式示例

```jsonl
{"id":"SMOKE-core-01","status":"pass","duration_ms":41,"timestamp":"2026-09-10T12:00:01Z"}
{"id":"SMOKE-core-10","status":"pass","duration_ms":38210,"timestamp":"2026-09-10T12:00:40Z"}
{"id":"SMOKE-core-12","status":"skip","timestamp":"2026-09-10T12:00:41Z"}
```
