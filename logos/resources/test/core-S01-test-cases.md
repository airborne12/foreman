# S01: Jira 单自动入库并生成分流卡 — 测试用例

> 输入：`core-S01-jira-intake.md`（31 Step，9 EX）、`api/worker-channel.yaml`（job.run / job.result / worktree.* / session.*）、`api/mcp.yaml`（deliver TriageArtifact）、`database/schema.sql`（source_items、tasks、context_packs、triage_cards、approvals、jobs、source_health、notifications）、PRD S01 验收条件
> 测试隔离：Jira 用 fake Jira（mock-service），agent 用 fake claude 脚本，飞书用 fake lark-cli；时钟可注入

## 一、单元测试用例

### 1.1 Jira 轮询作业参数与去重（来源：worker-channel.yaml → JobRun / JobResult；schema.sql → jobs.dedupe_key、source_items UNIQUE）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S01-01 | 生成 jira-poll 作业时 JQL 含 since 水位线 | S01 Step 1–4 | source_health.jira.watermark = T0 | tick(jira-poll) | job.args.jql 含 `updated >= T0`，required_label = vpn:jira |
| UT-S01-02 | 同 dedupe_key 的 queued 作业不重复入队 | schema.sql → idx_jobs_dedupe | 已有 queued 的 jira-poll | 再次 tick | jobs 表仍 1 行，返回已存在作业 id |
| UT-S01-03 | job.result 缺少 ok 字段被拒 | worker-channel.yaml → JobResult.required | — | `{result: {}}` | 校验错误 VALIDATION_FAILED |
| UT-S01-04 | source_items 同 (source_type, external_id) 二次插入被忽略 | schema.sql → source_items UNIQUE | 已有 (jira, CIR-20001) | upsert 同键 | 行数不变，返回已有 task_id |
| UT-S01-05 | 水位线取 external_updated_at 最大值 | S01 Step 2 | 3 条 source_items，updated 不同 | 计算水位线 | 等于最大值 |

### 1.2 任务与上下文包创建（来源：schema.sql → tasks CHECK；tasks.yaml → RepoRef）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S01-06 | 任务 key 按序列生成且匹配 `^T-\d+$` | schema.sql → tasks.key CHECK | task_key_seq 当前 230 | 创建根任务 | key = T-231 |
| UT-S01-07 | 非法 kind 被 CHECK 拒绝 | schema.sql → tasks.kind CHECK | — | kind = "misc" | 数据库约束错误 |
| UT-S01-08 | Jira 项目映射命中时 repo_source = mapping | S01 Step 11 | project_repo_map {CIR: selectdb/selectdb-core} | project = CIR | repo_name = selectdb/selectdb-core，repo_source = mapping |
| UT-S01-09 | 映射缺失且无线索时 repo_source = unresolved | S01 EX-11.1 | 映射无 DORIS | project = DORIS | repo_name = null，repo_source = unresolved |
| UT-S01-10 | 上下文包 code_locations 超过 8 条被截断 | tasks.yaml → ContextPack.codeLocations maxItems 8 | — | deliver 10 条 | 存 8 条，事件记 truncated |
| UT-S01-11 | 来源默认频道不存在时自动创建 kind=source_default | Phase 2 假设、schema.sql → channels.kind | 无 jira 频道 | 首次入库 | channels 新增 slug=jira，kind=source_default |

### 1.3 分流卡与审批生成（来源：mcp.yaml → TriageArtifact；schema.sql → triage_cards、approvals；S06 Step 2–4）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S01-12 | deliver triage 缺 tier 被拒 | mcp.yaml → TriageArtifact.required | — | 无 tier | JSON-RPC 校验错误 |
| UT-S01-13 | repo.confidence < 0.6 时分流卡 repo 标待确认 | S01 EX-11.1、Phase 2 core-04 AI 规范 | — | confidence 0.55 | triage_cards.repo_name = null，candidates 保留 |
| UT-S01-14 | 分流卡就绪创建 triage_confirm 审批并置 pending_decision | S01 Step 24 | 任务 triaging | deliver triage | approvals 1 行 status=pending，tasks.state = pending_decision |
| UT-S01-15 | triage_confirm 已升级 auto 时不生成 pending 审批 | S06 EX-4.1 | trust_counters.triage_confirm.mode = auto | deliver triage | approvals.status = auto_approved，任务直接 queued |
| UT-S01-16 | 审批 key 匹配 `^A-\d+$` | schema.sql → approvals.key CHECK | — | 创建审批 | key = A-<seq> |

### 1.4 降级与通知（来源：S01 EX-12.1、EX-28.1、EX-28.2；schema.sql → notifications）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S01-17 | 无在线 build:doris runtime 时生成降级卡 | S01 EX-12.1 | dev 离线 | 路由 code-locate | triage_cards.degraded = true，degraded_reason 含"离线" |
| UT-S01-18 | 降级卡补齐时原位更新不新建审批 | S01 EX-12.1 | 已有降级卡与 pending 审批 | 二次 deliver triage | 同一 triage_cards 行更新，approvals 仍 1 行 |
| UT-S01-19 | 当日 approval 推送达 30 条后新通知标 deferred | S01 EX-28.2 | 当日 sent 30 条 | 新审批 | notifications.status = deferred，approvals.feishu_deferred = true |
| UT-S01-20 | 发送失败重试最多 3 次且退避 5 分钟 | S01 EX-28.1 | fake lark-cli 返回失败 | 触发发送 | attempts 递增到 3，next_attempt_at 间隔 5 分钟，最终 failed |
| UT-S01-21 | 代码定位受每家 agent 每 runtime 并发上限约束，名额释放后补派 | 架构 §额度保护；S01 Step 12–15 | 3 个 code-locate 作业排队；dev 注册时 claude、codex 上限各 1 | 注册 dev → 其中一个会话 failed | 注册后只下发 2 个 worktree.create，planned 会话 agent 为 claude 与 codex 各 1，1 个作业仍 queued；会话结束后补发第 3 个 worktree.create |
| UT-S01-23 | 分流结论的目标分支落进分流卡与任务，并出现在拍板卡上 | mcp.yaml → TriageArtifact.targetBranch；0002 迁移 | 任务 triaging | deliver triage 带 targetBranch，再补一次不带该字段的降级卡 | triage_cards.base_branch 与 tasks.base_branch 均为该分支；审批 payload.baseBranch 一致且 summaryLine 含「基线 …」；补齐降级卡不冲掉已判断出的分支 |
| UT-S01-22 | 代码定位 15 分钟超时：planned 也算；已交付分流卡的不降级 | S01 EX-22.1 | ① planned 会话 created_at = now-16min，started_at 为空；② 已交付非降级分流卡、停在 waiting_input 的会话，带一个 origin=hook 的问题 | tick(progress-watch) | ① sessions.state = stopped，降级卡原因含"超时"；② sessions.state = done，分流卡仍 degraded=false 且代码位置不变，钩子问题 status = timeout |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S01-01 | 新分配的 Jira 单从轮询到分流卡与飞书推送 | Step 1→31 | fake Jira 返回 CIR-20001（assignee=我）；runtime dev 在线（vpn:jira、build:doris）；fake claude 脚本在 get_task 后 deliver triage；fake lark-cli 记录发送 | 1 注入 tick(jira-poll) 2 worker 执行作业回传 3 等待 worktree.create/session.start 指令 4 fake claude 调 MCP get_task 与 deliver 5 读收件箱 | tasks 有 T-xxx 状态 pending_decision；context_packs.jira.key = CIR-20001，repo_source = mapping；triage_cards 存在且 degraded=false；approvals 1 行 pending 且 feishu_message_id 非空；fake lark-cli 收到 1 条含"待拍板"的私聊；events 含 inbox.new；总耗时 < 10 分钟（测试中 < 30 秒） |
| ST-S01-02 | 重复分配不重复建任务 | Step 10、EX-10.1 | ST-S01-01 完成 | 1 fake Jira 把 CIR-20001 改派他人再改回 2 两次 tick | tasks 仍 1 行；events 含 source.reassigned；无新审批 |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S01-03 | 无 vpn:jira runtime 时作业排队并在 runtime 上线后补跑 | EX-2.1 | 所有 runtime 离线 | tick 后再注册 dev | jobs 先 queued 且不重复；source_health.jira = no_runtime；dev 注册后作业 dispatched 并完成，水位线不变 |
| ST-S01-04 | Jira 不可达三次后告警一次 | EX-6.1 | fake Jira 返回 503 | 连续 3 次 tick | source_health.jira.consecutive_failures = 3，status unreachable；fake lark-cli 收到 1 条告警；第 4 次失败 1 小时内不再告警；水位线不推进 |
| ST-S01-05 | 无法推断目标仓库的单以待确认卡进入收件箱 | EX-11.1 | fake Jira 返回 DORIS-300，映射无 DORIS；fake claude deliver repo confidence 0.5 | 完整流程 | context_packs.repo unresolved；triage_cards.repo_name null 且 candidates 非空；收件箱 API 返回该卡 repo.source = unresolved |
| ST-S01-06 | 开发机离线时出降级卡，上线后补齐 | EX-12.1 | dev 离线 | tick → 分流 → 注册 dev → 补跑 | 第一次收件箱卡 degraded=true 且无 codeLocations；dev 上线后同一审批 key 的卡 degraded=false 且 codeLocations ≥ 1；events 含"代码定位已补齐" |
| ST-S01-07 | agent 启动失败后换家重试，再失败走降级卡 | EX-17.1 | fake claude 启动返回非零；fake codex 也失败 | 完整流程 | sessions 2 行 failed（agent 不同，attempt 1/2）；triage_cards.degraded=true；worktree 保留 |
| ST-S01-08 | 代码定位会话 15 分钟未 deliver 视为超时 | EX-22.1 | fake claude 启动后不回写；注入时钟 | 推进 15 分钟 | 收到 session.stop 指令；降级卡 degraded_reason 含"失败"或"超时"；线程可展开日志 |
| ST-S01-09 | 飞书发送失败不影响审批存在 | EX-28.1 | fake lark-cli 发送失败 | 完整流程 | approvals pending 且 feishu_message_id 为空；notifications failed 重试 3 次；收件箱仍有该卡 |
| ST-S01-10 | 当日推送超限改为整点合并 | EX-28.2 | 当日已 sent 30 条 approval 通知；注入时钟 | 新审批 → 推进到整点 | 立即无推送；整点 fake lark-cli 收到 1 条"你有 N 项待拍板"；收件箱正常 |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S01-11 [manual] | 真实 Jira Server 经 VPN 从开发机轮询到真实单 | Step 5→8 | 在开发机上以真实 `~/.jira.conf` 运行一次 jira-poll 作业，核对 issues 数与 Jira 网页一致 |
| ST-S01-12 [manual] | 真实飞书私聊收到待拍板消息且格式符合模板 | Step 27→29 | 手机上查看消息，核对模板字段与面板链接可点 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件：S01-AC-01、AC-02 → ST-S01-01、ST-S01-02
- [x] Phase 1 异常验收条件：AC-03、AC-04、AC-05 → ST-S01-05、ST-S01-06、ST-S01-04
- [x] EX 异常用例：EX-2.1、6.1、10.1、11.1、12.1、17.1、22.1、28.1、28.2 全部有 ST
- [x] API required 字段：JobResult.ok、TriageArtifact.tier → UT-S01-03、UT-S01-12
- [x] DB UNIQUE/CHECK：source_items UNIQUE、tasks.key/kind CHECK、approvals.key CHECK、jobs dedupe → UT-S01-04/06/07/16/02

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S01-AC-01 | 正常：新分配的 CIR 单在 10 分钟内出现分流卡，含档位、工作量、仓库、路径、代码定位；飞书收到待拍板 | ST-S01-01, UT-S01-08, UT-S01-14 |
| S01-AC-02 | 正常：重复分配不重复建任务，线程追加事件 | ST-S01-02, UT-S01-04 |
| S01-AC-03 | 异常：无法推断目标仓库，卡片标待确认并给候选 | ST-S01-05, UT-S01-09, UT-S01-13 |
| S01-AC-04 | 异常：开发机离线，降级卡出现，恢复后补跑并更新 | ST-S01-06, UT-S01-17, UT-S01-18 |
| S01-AC-05 | 异常：Jira 不可达，来源标红，恢复后按水位线补齐不丢单 | ST-S01-04, ST-S01-03, UT-S01-05 |
