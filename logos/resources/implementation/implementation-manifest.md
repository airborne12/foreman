# 实现清单

> 更新：2026-09-10。按批次追加；每批必须同时交付业务代码、测试代码与 OpenLogos reporter。

## 批次 1：项目骨架 + 测试基础设施 + S05

### 范围

- 场景：S05 接入一台 runtime 并让任务路由到它
- 端点：`GET /healthz`、`POST /api/runtimes/auth-check`、`GET /api/runtimes`、`GET /api/runtimes/{name}`、`POST /api/runtimes/{name}/gc`、`GET /api/system/sources`、`GET /api/system/settings`、`GET/POST /api/system/tunnels*`（本批补入 runtimes.yaml）、`/ws/worker`、`/ws/panel`；最小 `POST /api/tasks`、`GET /api/tasks`、`GET /api/tasks/{key}`、`GET /api/tasks/{key}/messages`；测试模式 `/__test/*`
- DB 表：runtimes、worktrees、sessions（对账与失联）、tasks、context_packs、channels、messages、events、notifications、jobs、source_health
- 覆盖用例：UT-S05-01 ~ UT-S05-30（30/30 pass），ST-S05-01 ~ ST-S05-11（11/11 pass），ST-S05-12 skip（延后）

### 代码结构

```
apps/center   Hono + ws：app.ts 组装；hub/workerHub.ts（worker 通道）；hub/panelHub.ts；domain/{runtimes,worktrees,tasks,notifications}.ts；
              scheduler.ts（注入时钟）；tunnel.ts（ssh -R 管理）；routes/{system,runtimes,tasks,test}.ts；adapters/feishu.ts（lark-cli / Fake）
apps/worker   worker.ts（注册、心跳、幂等指令、退避重连）；probe.ts（init 探测）；gc.ts（worktree 回收）；config.ts
apps/cli      commander：worker init/doctor/start/status/gc；center start/status/tunnel；runtime list/show；task new/list/show
packages/shared  protocol.ts（worker 通道 zod schema）、config.ts（worker.yaml / center.yaml）、routing.ts、errors.ts、constants.ts
test/helpers  reporter.ts（OpenLogos reporter）、testApp.ts、fakeWorker.ts、fakeSsh.ts、fakeBins.ts、seed.ts
test/orchestration  runner.ts（执行 scenario/*.json）、fixtures.ts、S05.test.ts
test/unit     S05.test.ts
```

### 与规格的偏离（需要知晓）

| 项 | 规格 | 实现 | 原因 |
|----|------|------|------|
| ORM | 架构文档选 Prisma 6 | `pg` 直连；`schema.sql` 作为 0001_init 迁移源，后续增量放 `apps/center/migrations/` | schema.sql 的 CHECK 约束与部分索引 Prisma 无法表达，避免两份真相；已同步更新 tech_stack |
| jobs.kind CHECK | 10 种 | 增加 `notification-retry`、`code-locate`、`context-retry` | 通知重试与代码定位/上下文补齐作业需要落 jobs 表 |
| 认证中间件 | 各路由文件自带 | 统一在 app.ts：`/api/runtimes/auth-check` 用 workerToken，其余 `/api/*` 与 `/__test/*` 用 panelToken | Hono 子应用 `use('*')` 挂载在 `/` 时会互相污染 |
| 隧道端点 | runtimes.yaml 未定义 | 新增 `/api/system/tunnels*` 四个端点与 TunnelStatus | CLI `center tunnel` 需要经中心 API 操作 |
| CLI 全局选项 | `--center` | 改为 `--center-url` | 与 `worker init --center` 冲突 |
| 面板 SPA | Phase 2 规格 | 未实现 | 本批无面板侧自动化用例；随 S03/S07 批次交付 |

### 延后项

- ST-S05-12：依赖 `POST /api/approvals/{key}/decide` 与 `session.resume` 送入 → 已在批次 2 转为 pass。
- worker 的 `session.start/resume/stop/logs`、`job.run`、`worktree.create` 指令 → 已在批次 2 实现。

### 运行方式

```bash
pnpm install
pnpm test            # 自动起 postgres:17 测试容器（foreman-test-pg:54329），写 logos/resources/verify/test-results.jsonl
pnpm typecheck
```

## 批次 2：S01（Jira 入库与分流卡）+ S03（拍板派发与会话生命周期）

### 范围

- 场景：S01 Jira 单自动入库并生成分流卡；S03 拍板分流路径并一键启动 agent；顺带实现 S06 的飞书 reaction → 审批决定（ST-S03-04 需要）与 S05 EX-23.1 离线排队补发
- 端点（新增）：`GET /api/inbox`、`GET /api/approvals`、`GET /api/approvals/{key}`、`POST /api/approvals/{key}/decide`、`POST /api/tasks/{key}/retry`、`POST /api/tasks/{key}/implement`、`POST /api/tasks/{key}/messages`（续接/离线排队；回答 ask_user 在 S07 批次）、`POST /mcp`（JSON-RPC：initialize、tools/list、tools/call → get_task / report_progress / request_approval / deliver / lookup_jira）；测试模式 `POST /__test/lark/emit`
- worker 通道：`job.run`（jira-poll / jira-lookup / jira-comment / gh-pr-view）、`worktree.create` → `worktree.ready`、`session.start/resume/stop/logs`、`session.started/state`、`error`（WORKTREE_FAILED / AGENT_START_FAILED / RESUME_FAILED）
- 调度作业：`jira-poll`（poll_seconds）、`progress-watch`（60s，代码定位 15 分钟超时）、`feishu-digest`（整点，超限待拍板合并）
- DB 表：source_items、triage_cards、approvals、actions、trust_counters、artifacts、jobs（dispatch/code-locate）、feishu_events、messages.seq（新增）
- 覆盖用例：UT-S01-01 ~ UT-S01-20（20/20 pass）、ST-S01-01 ~ ST-S01-10（10/10 pass）；UT-S03-01 ~ UT-S03-29（29/29 pass）、ST-S03-01 ~ ST-S03-17（17/17 pass）；ST-S05-12 由 skip 转 pass。全量 118/118（`openlogos verify` 预跑 exit=0）。人工用例 ST-S01-11/12、ST-S03-18/19 不在自动化范围。已知抖动：ST-S05-09（真实 worker 子进程 + 10 秒 stdout 等待）在整机负载高时偶发超时，单独重跑稳定通过。

### 代码结构（增量）

```
apps/center/src/domain/approvals.ts  审批请求、auto 直通、面板/飞书先到先得、bodyHash、overrides、信任 streak/promote/reset、动作执行器、MCP 等待者、失败重试项
apps/center/src/domain/intake.ts     Jira 轮询作业与去重、入库（映射/unresolved、EX-10.1 重新分配）、代码定位调度（离线降级 + 上线补跑）、分流卡与审批、超时、整点汇总
apps/center/src/domain/dispatch.ts   拍板后路由/选家/并发闸门、worktree.ready → session.start、会话状态机、启动失败换家、失败三选一、产物与子任务、镜像回写执行器、离线排队补发
apps/center/src/domain/mcp.ts        MCP 工具实现（任务级 token → 会话）；routes/mcp.ts、routes/approvals.ts
apps/worker/src/worktree.ts          git worktree 创建/复用、.foreman/context.md、task.json、.claude/settings.json 钩子
apps/worker/src/jira.ts              Jira Server REST（search / issue / comment），凭据取 JIRA_* 或 ~/.jira.conf
apps/worker/src/sessions.ts          claude --bg / codex exec 适配器（订阅版 CLI，剔除 API key 环境变量，MCP 指向中心）
test/orchestration/runner.ts         新增：假 agent 脚本引擎（按 mock.<agent>.script 经 MCP 调工具）、mcp.call/mcp.expectCall、mock.emit（飞书 reaction）、
                                     假 Jira 自动应答（job.run jira-*）、假 gh、include 的「复用/至」语义、假时钟推进时给假 worker 补心跳
test/unit/S01.test.ts、S03.test.ts；test/orchestration/S01.test.ts、S03.test.ts
```

### 与规格的偏离（需要知晓）

| 项 | 规格 | 实现 | 原因 |
|----|------|------|------|
| messages 表 | 无序号列 | 新增 `seq BIGSERIAL UNIQUE`，线程按 `(created_at, seq)` 排序与游标 | 注入时钟冻结时同一时刻多条消息按 UUID 排序不稳定；schema.sql 已同步 |
| jobs.kind CHECK | 批次 1 的 13 种 | 增加 `jira-comment`、`dispatch` | 镜像回写作业；worktree.create / session.start 指令需落库以关联 error.ref |
| SessionStart.env | 文字说明禁止 API key | zod `superRefine` 拒绝 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_AUTH_TOKEN`（FORBIDDEN_ENV） | 架构 2.5 的硬约束需要在协议层强制 |
| 分流卡 codeLocations | maxItems 8 | 超出截断到 8 并记 `context_pack.truncated` 事件 | tasks.yaml 约束 |
| 只交付分支（EX-25.1） | 收件箱失败卡"重试创建 PR" | `tasks.queue_reason='重试创建 PR…'`，`/api/inbox.failures` 含 state=failed 或 queue_reason 以"重试"开头的任务，任务保持 running | 不改变任务状态即可进入收件箱 |
| review 子任务 worktree | 与作者共用 | 为 review 子任务另建 worktree（`worktree.create` purpose=review） | 简化；后续可改为复用父任务 worktree |
| MCP 传输 | Streamable HTTP | 只实现 JSON 请求/响应（无 SSE 流） | 本批工具均为请求-响应；request_approval 以长请求阻塞最长 30 分钟 |
| 飞书事件 | lark-cli 长连接订阅 | 中心侧只提供 `decideByFeishu` 与测试端点 `/__test/lark/emit`；真实订阅进程随 S02/S06 批次 | 本批只需 reaction → 决定的路径 |

### 延后项

- 无。面板 SPA 在批次 5 交付，`scripts/smoke.sh` 与发布脚本随首次部署交付。
- worker 的 claude/codex 适配器未在自动化里执行（真实 CLI 属人工用例 ST-S03-18）。

## 批次 3：S06（审批双通道与信任升级）+ S07（会话进展与线程介入）

### 范围

- 场景：S06 飞书/面板双通道决定、信任升降级、作废与重建、事后否决与补偿；S07 进展摘要与日志、ask_user 与两通道回答、钩子推断问题、续接/停止/无进展
- 端点（新增）：`GET /api/trust`、`POST /api/trust/{type}/reset`、`POST /api/actions/{id}/revoke`、`GET /api/sessions/{id}/logs`、`POST /api/sessions/{id}/stop`；`POST /api/tasks/{key}/messages` 补齐回答问题（answered / resumed / queued，EX-25.1 返回 409 但消息仍送入）；MCP 新增 `ask_user`（阻塞，30 分钟）；测试端点 `POST /__test/approvals/request`、`POST /__test/approvals/{key}/supersede`、`POST /__test/actions/retry`、`POST /__test/mock/jira`，`/__test/lark/emit` 支持 `im.message.receive_v1`（按 parent_id 匹配问题/审批消息）
- 调度：`progress-watch` 增加无进展检测（10 分钟广播 `session.stale`，30 分钟告警一次并进收件箱，不自动停止）
- DB 表：questions、actions（revoked_at / revoke_reason / not_revocable）、trust_counters（threshold 可配）
- 覆盖用例：UT-S06-01 ~ UT-S06-29（29/29 pass）、ST-S06-01 ~ ST-S06-14（14/14 pass）；UT-S07-01 ~ UT-S07-28（28/28 pass）、ST-S07-01 ~ ST-S07-13（13/13 pass）。人工用例 ST-S06-15/16、ST-S07-14/15/16 不在自动化范围。全量 202/202（`openlogos verify` 预跑 exit=0；覆盖 75%，缺 S02/S04 的 66 个用例，Gate 仍 FAIL）。

### 代码结构（增量）

```
apps/center/src/domain/approvals.ts   新增 supersede / revoke（7 天回滚期、补偿器、不可撤回进收件箱）/ listTrust（13 counter + autoExecutions7d + 4 周趋势）/ resetTrust / retryAction；auto 执行的线程事件带 actionId
apps/center/src/domain/questions.ts   ask_user 问题、面板/飞书回答与唤醒、钩子推断（取日志尾行）、飞书回复路由（问题 / 审批消息引导 / 已答补充）
apps/center/src/domain/dispatch.ts    postMessage 三态、resumeSession（续接同一会话，done/stopped → running）、stopSession、sessionLogs、watchStaleSessions、RESUME_FAILED → 失败卡、fresh_session 附线程摘要
apps/center/src/clock.ts              FakeClock.advance 对周期定时器最多触发 130 次后跳到最后边界（7 天推进不再逐分钟跑作业）
test/orchestration/runner.ts          parallelGroup 并发步骤、runner.repeat、后台 mcp.call（handle）、mcp.expectCall 按 handle、断言路径插值、mock.expect 通用 handle、假 claude 记录 --bg --resume 参数
test/unit/S06.test.ts、S07.test.ts；test/orchestration/S06.test.ts、S07.test.ts
```

### 与规格的偏离（需要知晓）

| 项 | 规格 | 实现 | 原因 |
|----|------|------|------|
| 补偿范围 | "可撤回的动作撤回" | 可撤回类型固定为 rerun_ci / reply_review / jira_comment / feishu_reply / jira_transition_in_progress；其余 not_revocable | M1 的执行器尚无真实撤回能力，测试模式用假补偿器；真实撤回随后续批次接入 gh/Jira |
| 测试模式执行器 | 执行器为 Jira 评论 / 飞书回帖 / agent | 测试模式下 jira_comment 在无 vpn:jira runtime 时走中心侧假 Jira；reply_review 以飞书回帖正文模拟；rerun_ci 为空操作 | S06 编排没有 runtime，但要验证执行/失败/重试路径 |
| 钩子推断问题 | 取日志片段 | 经 worker 通道取最近 20 行，取最后一个非空行作为问题文本 | 无日志时用默认文案 |
| 无进展检测 | Step 48 只看 last_progress_at | 取 `COALESCE(last_progress_at, started_at, created_at)` | 会话启动后从未回写也应算无进展 |
| 只交付分支 → 收件箱 | 批次 2 的规则 | 仅当最近进展提到"创建 PR 失败"或产物标 prFailed 时才进收件箱 | S07 中 deliver(branch) 是正常完成路径 |

## 批次 4：S02（飞书显式入库与候选扫描）+ S04（IM 频道口语派活）

### 范围

- 场景：S02 表情/@ 入库、上下文抓取与降级补齐、回帖、候选扫描与入库/忽略；S04 频道、口语交调度员、斜杠命令兜底、草案确认、调度员空闲回收与响应超时
- 端点（新增）：`GET/POST /api/channels`、`GET/PATCH /api/channels/{slug}`、`GET /api/channels/{slug}/threads`、`GET/POST /api/channels/{slug}/messages`、`POST /api/drafts/{id}/confirm|cancel`、`POST /api/candidates/{id}/intake|dismiss`、`POST /api/tasks/{key}/pause|resume`；收件箱补上 candidates 分组
- MCP 新增：`propose_task`、`ask_clarification`、`list_tasks`、`lookup_pr`；`deliver` 支持无任务的候选扫描会话回写 candidates
- 调度：`candidate-scan`（默认每小时，需 `sources.feishu.scan_enabled`）、`context-retry`（每分钟，5 分钟后补齐，最多 3 次）、`dispatcher-idle`（每分钟：60 秒响应超时提示一次、空闲 30 分钟回收）
- 覆盖用例：UT-S02-01 ~ UT-S02-17（17/17 pass）、ST-S02-01 ~ ST-S02-11（11/11 pass）；UT-S04-01 ~ UT-S04-26（26/26 pass）、ST-S04-01 ~ ST-S04-12（12/12 pass）。人工用例 ST-S02-12/13、ST-S04-13/14 不在自动化范围。全量 268/268 通过，`openlogos verify` 覆盖度 100%（268/268），Gate 3.6 PASS，已生成 `logos/resources/verify/acceptance-report.md`。

### 代码结构（增量）

```
apps/center/src/adapters/feishu.ts      FeishuAdapter 增加 fetchContext / fetchRecent；FakeFeishu 带消息库与 failGetOnce
apps/center/src/domain/feishuIntake.ts  事件解析与过滤、去重、入库与回帖、上下文补齐、候选扫描/入库/忽略、扫描超时
apps/center/src/domain/channels.ts      频道 CRUD、频道消息、调度员拉起/续接/回收、斜杠命令解析器、草案与确认
apps/center/src/domain/dispatch.ts      startTextSession（无任务的频道会话）、pickFreeAgent（并发闸门）、session.start 支持 taskKey 为空
apps/center/src/routes/channels.ts      频道与草案端点
test/unit/S02.test.ts、S04.test.ts；test/orchestration/S02.test.ts、S04.test.ts
test/orchestration/runner.ts            脚本引擎支持 onResume/sleepSeconds/{{regex}}/{{fromListTasks}}/{{resumeText}}；长跳时钟分段；ws.expect 字符串按包含匹配
```

### 与规格的偏离（需要知晓）

| 项 | 规格 | 实现 | 原因 |
|----|------|------|------|
| 候选扫描开关 | S02 Step 18 每小时一次 | 需 `sources.feishu.scan_enabled`（假 lark 配置好消息库时由测试打开） | 没有飞书消息源时空扫会误占 agent 名额 |
| 扫描并发 | 未规定 | 上一轮扫描会话还在跑就跳过（`IN_PROGRESS`） | 避免重复扫同一批消息 |
| 扫描水位线 | Step 19 「上次扫描」 | 只在候选回写成功后推进水位线 | 会话超时未回写时下一轮要重扫，否则丢消息 |
| 降级分流卡的 repo_source | S01 EX-12.1 只说卡片降级 | 降级卡不把入库时的 `llm`/`mapping` 下调为 `unresolved` | 代码定位还没跑，不能算「已判定无法确定仓库」 |
| 调度员响应超时 | Step 30「30 秒内未出现草案」 | 按 EX-30.1 的 60 秒发一次提示，会话不停 | 两处数值不一致时以异常用例 EX-30.1 为准 |
| 频道会话 cwd | 未规定 | 文本类会话（dispatcher / candidate_scan）用 `/tmp` | 这类会话不需要 worktree |

## 批次 5：面板 SPA（core-02-panel-design.md）

### 范围

- `apps/panel`：Vite + React + TypeScript，构建产物进 `apps/center/public`，由中心在同一个端口 7801 提供
- 路由（§2.1）：`/inbox`、`/c/:channel`、`/c/:channel/t/:taskKey`、`/runtimes`、`/trust`、`/settings`；history API + 中心侧 SPA 回退
- 布局（§2.2）：三栏，1180px 以下收起右栏，820px 以下只留中栏
- 配色与字体按 §1：背景 `#0F172A`、面板 `#1E293B`、行动色 `#22C55E`、待拍板 `#F59E0B`、失败 `#EF4444`；正文 Fira Sans，编号与日志 Fira Code
- 实时：`/ws/panel` 推送到达即刷新当前视图，断线显示红条并自动重连
- 鉴权：panelToken 存 localStorage，首屏是 token 门，401 自动回到门

### 各视图

| 视图 | 能做的事 |
|------|---------|
| 收件箱 | 分流卡（改档位/仓库/runtime/agent → 按建议执行或按修改执行、否决）、需要输入（回答即送入会话）、失败三选一（重试/换 agent/新会话/放弃）、候选（入库/忽略）；`j`/`k`/`Enter` 快捷键 |
| 频道 | 消息流、草案卡（创建/取消）、线程列表、口语与斜杠命令输入框，调度员不可用时显示预填命令 |
| 线程 | 消息流（系统事件、进展、审批卡、产物卡、失败卡、澄清）、右栏任务详情（上下文包、分流卡、任务树、会话与 worktree、产物、待处理审批）、展开会话日志、停止会话、暂停/恢复、按方案实现 |
| 状态 | runtime 表（在线、标签、会话数、磁盘、版本、心跳）、来源健康度、反向隧道；点行看详情与告警 |
| 信任 | 13 个动作类型的模式、连续确认、7 天自动执行数、近 4 周人工确认趋势、重置为人工（锁定类型禁用） |
| 设置 | 只读展示中心配置 |

### 代码结构（增量）

```
apps/panel/{index.html,vite.config.ts,tsconfig.json,package.json}
apps/panel/src/{main.tsx,app.tsx,api.ts,styles.css}
apps/panel/src/views/{Inbox,Channel,Thread,Message,Runtimes,Trust,Settings}.tsx
apps/center/src/app.ts    mountPanel()：静态资源 + 前端路由回退，/api /ws /mcp /healthz /__test 不被遮蔽
scripts/build.sh          先构建面板再打三个单文件 bundle
```

### 与设计的偏离（需要知晓）

| 项 | 设计 | 实现 | 原因 |
|----|------|------|------|
| 登录 | 「登录后收件箱可见」 | 输入 panelToken 的门，token 存 localStorage | M1 没有账号体系，中心只认一个 panelToken |
| 设置页 | 可改来源频道、路由默认值、并发、表情、Jira 映射 | 只读展示 | 中心尚无写配置的端点，改配置仍是编辑 center.yaml 后重启 |
| 草案卡 | 已确认的草案不应再显示按钮 | 历史消息里的草案卡按钮仍在，点了会 409 | 消息 payload 没带草案状态；错误会以红条提示 |
| 字体 | Fira Sans / Fira Code | 用同名字体，未安装时退回系统字体栈 | 内网环境不从公网加载字体 |
