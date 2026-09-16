# S05: 接入一台 runtime 并让任务路由到它 — 测试用例

> 输入：`core-S05-runtime-onboarding.md`（24 Step，7 EX）、`api/runtimes.yaml`（healthz、auth-check、listRuntimes、getRuntime、runtimeGc）、`api/worker-channel.yaml`（Register/RegisterAck/Heartbeat/SessionList/WorktreeGc）、`core-03-runtime-cli-design.md`（init/doctor/start、worker.yaml）、`database/schema.sql`（runtimes、worktrees、sessions）、PRD S05 验收条件
> 测试隔离：ssh 用假 ssh 命令（env-disable 隧道），worker 进程在测试内以 direct 传输启动；探测用假二进制目录

## 一、单元测试用例

### 1.1 worker init 与 doctor（来源：core-03 §3.1、§4 S05.1）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S05-01 | 探测到 claude 与 git、未探测到 codex 时标签正确 | S05 Step 2 | PATH 只含假 claude、git | init 探测 | labels 含 agent:claude，不含 agent:codex；输出含警告 |
| UT-S05-02 | 存在 thirdparty/installed 时打 build:doris | Step 2 | 假仓库含 thirdparty/installed | 探测 | labels 含 build:doris、repo:<name> |
| UT-S05-03 | 生成的 worker.yaml 通过 schema 校验且权限 0600 | Step 2 | — | init 非交互参数 | 文件存在，mode 0600，字段齐全 |
| UT-S05-04 | doctor 在 token 401 时输出红项退出 1 | EX-5.1 | fake center 返回 401 | doctor | 退出码 1，输出含"token 无效" |
| UT-S05-05 | doctor 在中心不可达时按 transport 给提示 | EX-5.2 | 无 center 监听 | doctor（reverse-tunnel） | 退出码 1，输出含"tunnel" 提示 |
| UT-S05-06 | auth-check 用 workerToken 而非 panelToken | runtimes.yaml → runtimeAuthCheck security | — | 带 panelToken 调 auth-check | 401 |

### 1.2 注册与心跳（来源：worker-channel.yaml → Register / RegisterAck / Heartbeat；schema.sql → runtimes）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S05-07 | Register 缺 instanceId 被拒 | Register.required | — | 无 instanceId | error VALIDATION |
| UT-S05-08 | agents.maxConcurrent < 1 被拒 | Register.agents.maxConcurrent minimum | — | 0 | error |
| UT-S05-09 | 注册成功 upsert runtimes online=true 且返回 heartbeatSeconds=30 | Step 11–13 | — | 有效 Register | runtimes 1 行 online，registered_at 非空；ack.heartbeatSeconds = 30 |
| UT-S05-10 | 连接后 5 秒未 register 被断开 | worker-channel.yaml → /ws/worker 说明 | — | 只连接不发 | 连接关闭 |
| UT-S05-11 | 错误 token 关闭码 4001 且返回 AUTH_INVALID | EX-10.1 | — | Bearer 错 | 关闭码 4001，error.code AUTH_INVALID |
| UT-S05-12 | 版本过旧返回 VERSION_UNSUPPORTED | EX-10.1 | minWorkerVersion 0.2.0 | version 0.1.0 | error VERSION_UNSUPPORTED |
| UT-S05-13 | 同名不同 instanceId 且旧连接活跃 → RUNTIME_NAME_CONFLICT | EX-12.1 | dev 已连接（inst A） | inst B 注册 dev | 拒绝，旧连接不变 |
| UT-S05-14 | 同名同 instanceId 重连替换旧连接 | EX-12.1 | dev 连接 inst A 断开 | inst A 再注册 | 接受，pendingCommands 回放 |
| UT-S05-15 | 心跳更新 last_seen_at、disk、load | Step 18–19 | 在线 | Heartbeat | 三列更新 |
| UT-S05-16 | 心跳 disk.usedRatio ≥ 0.85 触发 worktree.gc high_watermark | EX-19.1 | — | usedRatio 0.9 | 下发 worktree.gc policy=high_watermark，protectedTaskKeys 含 running 任务 |
| UT-S05-17 | runtimes.name 不符合 slug 规则被 CHECK 拒绝 | schema.sql → runtimes.name CHECK | — | name "Dev Box" | 约束错误 |

### 1.3 离线判定与对账（来源：Step 16–17、21–24；schema.sql → sessions.reachable）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S05-18 | last_seen 超过 90 秒标离线并把其会话 reachable=false | Step 22–23 | dev 有 2 个 running 会话 | tick(heartbeat-check) at +91s | runtimes.online false；sessions.reachable false；tasks.state 不变 |
| UT-S05-19 | 89 秒不判离线 | Step 22 | — | tick at +89s | online 仍 true |
| UT-S05-20 | session.list 对账：本机不存在的会话标 lost，并关掉它推断出的问题 | Step 16–17；EX-19.1 | DB 有 3 个 running，worker 报 2 个；缺失那个带一条 origin=hook 的 open 问题 | session.list | 缺失那个 state=lost，其余 reachable=true；该会话的 hook 问题 status=timeout（会话没了，没人能回答） |
| UT-S05-21 | 离线期间指令写入 pendingCommands 并在 ack 时按序回放 | Step 13、EX-23.1 | dev 离线，排队 2 条指令 | 注册 | ack.pendingCommands 长度 2 且顺序一致 |
| UT-S05-22 | 连续离线 5 分钟只推一次飞书告警 | Step 24 | 注入时钟 | 离线 5 分钟、10 分钟 | notifications alert 1 条 |

### 1.4 路由规则（来源：Step 20；center.yaml routing）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S05-23 | require 标签全部命中才候选 | Step 20 | dev 缺 vpn:jira | 作业 required vpn:jira | 无候选，作业 queued |
| UT-S05-24 | 多候选取 prefer | Step 20 | dev 与 laptop 都满足 code | route code | dev |
| UT-S05-25 | prefer 不在线时取会话最少者 | Step 20 | dev 离线；laptop 2 会话，center 0（都满足） | route | center |
| UT-S05-26 | text 类型 prefer center | routing.text | center 在线 | route text | center |

### 1.5 worktree 回收（来源：WorktreeGc / GcResult；core-03 §5.2）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S05-27 | dryRun 只列不删 | runtimeGc dryRun | 4 个可回收 | gc dryRun | removed 列表 4 项，磁盘文件仍在，worktrees.state 不变 |
| UT-S05-28 | retain_days 策略只删终态超 3 天 | WorktreeGc.retainDays | 终态 2 天与 4 天各 1 | gc retain_days | 只删 4 天的 |
| UT-S05-29 | protectedTaskKeys 中的 worktree 永不删 | WorktreeGc.protectedTaskKeys | running 任务 worktree 最老 | gc high_watermark | 跳过它，skippedRunning ≥ 1 |
| UT-S05-30 | 删除后写任务线程事件与 worktrees.removed_at | core-03 §5.2 | — | gc | events 每个删除 1 条；removed_at 非空 |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S05-01 | 笔记本直连：init → doctor → start → 面板可见 | Step 1→5、8→15 | 测试 center 监听；假二进制目录含 claude、opencode、git | 1 `foreman worker init` 非交互 2 `foreman worker doctor` 3 `foreman worker start --foreground` 4 GET /api/runtimes | doctor 退出 0；runtimes 出现 laptop online transport=direct，labels 含 agent:claude 不含 build:doris；events runtime.updated |
| ST-S05-02 | 反向隧道接入（假 ssh） | Step 6→17 | 假 ssh 命令把 -R 映射为本地端口转发 | 1 `foreman center tunnel dev up` 2 worker 以 reverse-tunnel 配置连接 127.0.0.1 端口 3 `foreman center tunnel dev status` | 隧道 status up；runtimes dev online transport=reverse-tunnel，labels 含 build:doris、vpn:jira；session.list 对账无 lost |
| ST-S05-03 | 按类型路由与手动覆盖 | Step 20 | dev、center、laptop 在线 | 1 POST /api/tasks code 类 2 POST text 类 3 decide 时 override runtime=laptop | 前者 runtime dev（事件含 require build:doris）；后者 center；覆盖后 laptop 且事件含"手动覆盖" |
| ST-S05-04 | 心跳与状态视图字段 | Step 18–19 | dev 在线 | 发 3 次心跳 → GET /api/runtimes/dev | lastSeenAt 更新；diskUsedRatio、load 与最后一次心跳一致；agents 各家 running/max 正确 |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S05-05 | doctor 发现 token 无效 | EX-5.1 | 错误 token | doctor | 退出 1，无副作用 |
| ST-S05-06 | doctor 中心不可达提示先建隧道 | EX-5.2 | center 未启动 | doctor（reverse-tunnel） | 退出 1，提示含 `foreman center tunnel` |
| ST-S05-07 | 隧道断开重连，worker 离线不超过 90 秒 | EX-7.1 | 假 ssh 支持被 kill 后由隧道管理重启 | kill 假 ssh | tunnel status reconnects +1；runtimes.dev 离线时间 < 90 秒；5 分钟内恢复不推告警 |
| ST-S05-08 | 隧道 5 分钟无法重建推一次告警 | EX-7.1 | 假 ssh 持续失败；注入时钟 | 推进 5 分钟、10 分钟 | notifications alert 1 条 |
| ST-S05-09 | worker token 错误退避重试 | EX-10.1 | 错 token | start --foreground | 日志含 AUTH_INVALID 与 60s/120s/300s 退避；`worker status` 显示 auth_failed；中心记录失败次数 |
| ST-S05-10 | runtime 名冲突被拒 | EX-12.1 | dev 已由另一 instance 连接 | 第二台以 dev 注册 | RUNTIME_NAME_CONFLICT；原连接不受影响 |
| ST-S05-11 | 磁盘高水位自动回收 | EX-19.1 | dev 有 2 个终态 1 天 worktree、3 个 running；心跳 disk 0.88 | 心跳 | worker 收到 gc high_watermark；删 2 个，running 保留；面板 runtime 标黄字段（reclaimableWorktrees）随后为 0；每个删除写事件 |
| ST-S05-12 | 离线期间任务排队与消息排队，上线后补发 | EX-23.1 | dev 离线 | 1 创建需 dev 的任务并拍板 2 对 dev 上会话追加消息 3 注册 dev | 任务 queued 含原因；消息 delivery=queued；注册 ack.pendingCommands 含 session.start 与 session.resume 且按序执行 |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S05-13 [manual] | 真实开发机 systemd --user 常驻并在重启后自动拉起 | Step 9 | `systemctl --user status foreman-worker`，重启机器或 `loginctl` 会话后确认仍在 |
| ST-S05-14 [manual] | 真实 ssh -R 隧道在中心机 launchd 下断线自动重连 | Step 7 | 中心机断网 30 秒后恢复，`foreman center tunnel dev status` reconnects +1 且 worker 重新在线 |
| ST-S05-15 [manual] | 真实探测：开发机 init 打出 build:doris 与 vpn:jira | Step 2 | 在开发机跑 `foreman worker init` 核对标签 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件 AC-01/02/03/04 → ST-S05-02、ST-S05-01、ST-S05-03、ST-S05-03
- [x] Phase 1 异常验收条件 AC-05/06 → UT-S05-18、ST-S05-09
- [x] EX：5.1、5.2、7.1、10.1、12.1、19.1、23.1 全部覆盖
- [x] API required：Register.instanceId、maxConcurrent、auth-check 安全方案 → UT-S05-07/08/06
- [x] DB CHECK：runtimes.name → UT-S05-17

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S05-AC-01 | 正常：开发机通过反向隧道接入，面板显示在线与标签 | ST-S05-02, UT-S05-09 |
| S05-AC-02 | 正常：笔记本直连接入，标签不含 build:doris | ST-S05-01, UT-S05-01 |
| S05-AC-03 | 正常：代码类去开发机、文本类去中心机并显示依据 | ST-S05-03, UT-S05-24, UT-S05-26 |
| S05-AC-04 | 正常：手动覆盖 runtime 并记录 | ST-S05-03 |
| S05-AC-05 | 异常：连续 3 次心跳未到判离线，会话标失联不改派，恢复后对账 | UT-S05-18, UT-S05-19, UT-S05-20, ST-S05-12 |
| S05-AC-06 | 异常：token 错误被拒，明确错误，退避至少 60 秒 | ST-S05-09, UT-S05-11 |
