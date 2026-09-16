# S03: 拍板分流路径并一键启动 agent — 测试用例

> 输入：`core-S03-decide-and-dispatch.md`（34 Step，11 EX）、`api/approvals.yaml`（decideApproval）、`api/tasks.yaml`（retryTask、implementFromPlan、Session）、`api/worker-channel.yaml`（worktree.create、session.start/started/state）、`api/mcp.yaml`（request_approval、deliver）、`database/schema.sql`（approvals、tasks、sessions、worktrees、trust_counters、artifacts）、PRD S03 验收条件
> 测试隔离：fake claude / fake codex 脚本（按脚本时间线调 MCP），fake gh，fake lark-cli

## 一、单元测试用例

### 1.1 拍板请求校验（来源：approvals.yaml → decideApproval requestBody）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S03-01 | 缺 bodyHash 被拒 | decideApproval.required | pending 审批 | `{decision: approve}` | 422 VALIDATION_FAILED |
| UT-S03-02 | decision 非法枚举被拒 | decision enum | — | `{decision: maybe, bodyHash}` | 422 |
| UT-S03-03 | overrides.path 非法枚举被拒 | overrides.path → TaskPath | — | path = "hotfix" | 422 |
| UT-S03-04 | overrides.agent 非法被拒 | AgentName enum | — | agent = "gemini" | 422 |
| UT-S03-05 | approvalKey 不匹配 `^A-\d+$` 返回 404 | approvals.yaml → approvalKey pattern | — | GET /api/approvals/X-1 | 404 |

### 1.2 先到先得与信任计数（来源：schema.sql → approvals 条件更新；S03 Step 4–6；S06 Step 19）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S03-06 | 条件更新只在 pending 且 hash 匹配时生效 | S03 Step 4 | pending，hash H | decide(H) | 影响 1 行，status approved |
| UT-S03-07 | 已决定的审批再次决定影响 0 行 → 409 | S03 EX-4.1 | 已 approved via feishu | decide(H) | 409 APPROVAL_ALREADY_DECIDED，body 含 decidedVia = feishu |
| UT-S03-08 | 原样确认使 triage_confirm streak +1 | S03 Step 6 | streak 1 | approve 无 overrides | streak 2，modified = false |
| UT-S03-09 | 带 overrides 确认不计数且 modified = true | S03 Step 6 | streak 1 | approve 带 runtime override | streak 仍 1，approvals.modified = true，tasks.decision.modified = true |
| UT-S03-10 | 仓库待确认且无 override 时 422 REPO_REQUIRED 且事务回滚 | S03 EX-6.1 | repo_name null | approve 无 overrides.repo | 422；approvals 仍 pending |

### 1.3 路由与选家（来源：S03 Step 7；routing 配置；schema.sql → idx_sessions_runtime_agent_active）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S03-11 | code 类任务要求 build:doris，命中 dev | routing.code | dev 在线含标签 | route | runtime = dev，线程事件含路由依据 |
| UT-S03-12 | 无满足标签的在线 runtime 时 queued 并记原因 | S03 EX-7.1 | dev 离线 | route | tasks.state queued，queue_reason 含 "dev" |
| UT-S03-13 | 手动覆盖优先于规则 | S03 Step 7 | override runtime = laptop（在线） | route | runtime = laptop |
| UT-S03-14 | 开发 agent 轮换：上次 claude 则本次 codex | S03 Step 7 | 上一实现任务 author_agent = claude | 选家 | agent = codex |
| UT-S03-15 | review 子任务 agent 必须不同于 author_agent | S03 Step 29 | author = codex | 创建 review 子任务 | agent = claude |
| UT-S03-16 | 并发闸门：同 runtime 同 agent planned+running ≥ 3 时排队 | S03 EX-7.2 | dev 上 codex 3 个 running | 选 codex | queued，queue_reason 含队列位置 |
| UT-S03-17 | 分析类任务并发满时换家，代码类不换 | S03 EX-7.2 | codex 满，claude 空 | kind analysis / kind code | analysis → claude；code → queued |
| UT-S03-18 | planned 会话占用并发名额 | schema.sql → sessions.state planned | 2 running + 1 planned | 新会话 | 排队 |

### 1.4 worktree 与会话指令（来源：worker-channel.yaml → WorktreeCreate / SessionStart）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S03-19 | worktree.create 缺 baseBranch 被拒 | WorktreeCreate.required | — | 无 baseBranch | 校验错误 |
| UT-S03-20 | 默认 branchName = foreman/<taskKey> | WorktreeCreate.branchName | — | 不传 | foreman/T-231 |
| UT-S03-21 | session.start 的 env 含 ANTHROPIC_API_KEY 被拒 | SessionStart.env 说明、架构 2.5 | — | env 含该键 | 校验错误 FORBIDDEN_ENV |
| UT-S03-22 | 同一 commandId 重放不重复创建 worktree | worker-channel.yaml Envelope 幂等 | worker 已执行 cmd-1 | 再收 cmd-1 | 回放上次 worktree.ready，不再执行 git |
| UT-S03-23 | 同任务重试复用已有 worktree | S03 Step 11 | worktrees 有 ready 行 | worktree.create reuseIfExists | worktree.ready.reused = true |
| UT-S03-24 | worker 写入 .foreman/context.md、task.json，把 buildEnv 写进 custom_env.sh，并把 .foreman/ 挡在提交之外 | S03 Step 11 | 临时 git 仓库 | 执行 create，buildEnv = {DORIS_THIRDPARTY} | context.md、task.json 存在；custom_env.sh 含 `export DORIS_THIRDPARTY="…"`；未传 hooks 时不写 .claude/settings.json；worktree 的 info/exclude 含 `.foreman/` 且 `git status` 不再列出它（否则 agent 的 `git add -A` 会把上下文包与日志提交进 PR） |
| UT-S03-30 | claude --bg 启动参数、工具黑名单与会话 id 解析 | S03 Step 15；claude 2.1.26x 实测 | fake claude：`--bg` 输出 `backgrounded · 3f171235 · T-231-implement`，`agents --json --all` 返回该短 id 与完整 sessionId；配置 disallowedTools | session.start | 参数含 `--permission-mode auto`、`--strict-mcp-config`、`--mcp-config=<json>`、`--disallowedTools=<逗号分隔>`（都带 =，变长参数用空格写法会吞掉 prompt），prompt 仍是最后一个参数；agentSessionId 为完整 UUID，shortId 为 3f171235 |
| UT-S03-31 | codex 启动带 workspace-write 沙箱，续接不带 -C | S03 Step 15；codex exec resume --help | — | codexStartArgs / codexResumeArgs | 启动含 `-C <cwd>` 与 `sandbox_mode="workspace-write"`；续接以 `exec resume` 开头、不含 `-C`、含 MCP 配置，最后两个参数为 threadId 与文本 |

### 1.5 产物与子任务（来源：mcp.yaml → DeliverInput；schema.sql → artifacts、tasks 子任务 key）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S03-25 | deliver artifacts 为空数组被拒 | DeliverInput.artifacts minItems 1 | — | `[]` | 校验错误 |
| UT-S03-26 | PR 产物创建 T-231.1(kind pr) 与 T-231.2(kind review) | S03 Step 29 | 根任务 T-231 running | deliver pr | 两个子任务，key 匹配 `^T-\d+\.\d+$`，tasks.state delivered |
| UT-S03-27 | 出方案产物不创建 PR 子任务，implementFromPlan 可用 | tasks.yaml → implementFromPlan | deliver doc | POST implement | 202，新会话 kind implement，context_packs.plan_doc = 文档全文 |
| UT-S03-28 | 无方案产物时 implementFromPlan 409 | implementFromPlan 409 | 无 doc 产物 | POST implement | 409 NO_PLAN_ARTIFACT |
| UT-S03-29 | retryTask 在非 failed 状态返回 409 | retryTask 409 | 任务 running | POST retry | 409 TASK_NOT_FAILED |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S03-01 | 简单修复从拍板到 PR 与子任务 | Step 1→34 | T-231 pending_decision（分流卡 fix，repo selectdb-core）；dev 在线（claude、codex 空闲）；上一实现任务 author=claude；fake codex 脚本：report_progress ×2 → request_approval(create_pr) → gh pr create → deliver pr → 退出 0；fake gh 返回 PR url；fake lark-cli | 1 POST decide approve（原样） 2 等待 worktree.create/session.start 3 fake codex 跑到 request_approval 4 收件箱出现 A-90 → POST decide approve 5 等待 deliver 与 session.state done | tasks.state 依次 queued→running→delivered；sessions.agent = codex，state done；worktrees ready 且路径含 T-231；artifacts 1 行 kind pr；子任务 T-231.1(pr) 与 T-231.2(review, agent=claude)；approvals 有 triage_confirm 与 create_pr 各 1 行 approved；trust triage_confirm streak +1，create_pr streak +1；随后出现 feishu_reply 或 jira_comment 类型审批 |
| ST-S03-02 | 出方案路径并按方案实现 | Step 1→30（plan） + implementFromPlan | 分流卡 tier plan；fake claude deliver doc | 1 decide approve 2 等待 doc 产物 3 POST /api/tasks/T-231/implement | artifacts kind doc 含 content；收件箱出现"方案待拍板"（approval 或 inbox 项）；implement 后新会话 kind implement 同 runtime，无新分流卡，context_packs.plan_doc 非空 |
| ST-S03-03 | 修改 runtime 后执行不计数 | Step 1→6 | dev 与 laptop 在线 | decide approve overrides.runtime = laptop | tasks.runtime_name = laptop；decision.modified = true；trust triage_confirm streak 不变；线程事件含"手动覆盖" |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S03-04 | 飞书先批后面板再批返回 409 | EX-4.1 | 审批 pending | 先注入飞书 ✅ 事件，再 POST decide | 409 且 decidedVia = feishu；任务只启动一次会话 |
| ST-S03-05 | 仓库待确认时无法执行 | EX-6.1 | 分流卡 repo unresolved | POST decide 无 repo override | 422 REPO_REQUIRED；审批 pending；带 overrides.repo 再试 200 |
| ST-S03-06 | 开发机离线排队，上线后自动启动 | EX-7.1 | dev 离线 | decide → 注册 dev | 先 queued（queue_reason 含 dev）且无 session；dev 注册后 10 秒内 session.start 下发，任务 running |
| ST-S03-07 | 并发已满排队并在会话结束后启动 | EX-7.2 | dev 上 codex 3 个 running（fake） | decide（轮换到 codex） | queued 显示队列位置；结束一个 codex 会话后新会话启动 |
| ST-S03-08 | 分析类任务并发满自动换家 | EX-7.2 | codex 满，claude 空；任务 kind analysis | decide | sessions.agent = claude；线程事件含"已改派 claude" |
| ST-S03-09 | worktree 创建失败先 fetch 重试再失败卡 | EX-11.1 | fake git 首次失败、fetch 后仍失败 | decide | worker 两次尝试；tasks.state failed；收件箱失败卡含"重试 / 放弃"；error 含 WORKTREE_FAILED |
| ST-S03-10 | agent 启动失败自动换家一次 | EX-15.1 | fake codex 启动失败，fake claude 成功 | decide | sessions 2 行：codex failed（attempt 1）、claude running（attempt 2），同一 worktree_id；线程含两次 stderr 摘要 |
| ST-S03-11 | 创建 PR 审批超时后续接送回批准 | EX-22.1 | fake codex 在 request_approval 后若超时则 report_progress 并退出；注入时钟 | 推进 30 分钟不处理 → 再 decide approve | MCP 返回 approved=false reason=timeout；tasks.state waiting_approval；decide 后下发 session.resume 文本含"已批准" |
| ST-S03-12 | 审批被否决，信任清零 | EX-23.1 | create_pr streak 3 | decide reject comment="改标题" | MCP 返回 rejected 与 comment；trust create_pr streak 0 mode manual；线程记录否决原因 |
| ST-S03-13 | gh pr create 失败只交付分支 | EX-25.1 | fake gh 返回非零 | 完整流程 | artifacts kind branch；收件箱失败卡"重试创建 PR"；tasks.state running |
| ST-S03-14 | 会话失败三选一：换 agent | EX-32.1 | fake codex 退出非零无 deliver | 等 failed → POST retry mode=switch_agent | tasks.state failed → queued；新 session agent=claude 同 worktree；并发名额释放（sessions 活跃计数正确） |
| ST-S03-15 | 会话失败三选一：放弃 | EX-32.1 | 同上 | POST retry mode=abandon | tasks.state paused，terminal_at 非空；worktree 保留 state ready |
| ST-S03-16 | 镜像回写失败生成重试条目 | EX-34.1 | fake Jira comment 返回 500 | 主路径完成后审批 jira_comment 通过 | approvals.status failed；actions.status failed；收件箱有"重试回写"；tasks.state 不变 |
| ST-S03-17 | worktree 终态 3 天后回收，磁盘高水位优先 | S03 EX-9.x / S05 EX-19.1 | 4 个 done 超 3 天 + 2 个 done 1 天 + 3 个 running；注入时钟与磁盘 88% | 1 定时 gc 2 高水位 gc | 定时：删 4 个；高水位：再删 2 个 1 天的，running 不删；每次删除写对应任务事件；worktrees.state removed |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S03-18 [manual] | 真实开发机上以 claude --bg 启动实现会话并经隧道回写 MCP | Step 13→20 | 在开发机上对一个只读任务跑一次，核对 `claude agents --json` 有会话且面板线程出现进展 |
| ST-S03-19 [manual] | 真实 selectdb-core 的 worktree 构建环境软链正确 | Step 11 | 在生成的 worktree 里执行 `ls -l thirdparty/installed` 与 `build.sh --fe` 前置检查通过 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件 AC-01/02/03 → ST-S03-01、ST-S03-02、UT-S03-14/15
- [x] Phase 1 异常验收条件 AC-04/05/06/07 → ST-S03-06、ST-S03-07/08、ST-S03-14/15、ST-S03-17
- [x] EX：4.1、6.1、7.1、7.2、11.1、15.1、22.1、23.1、25.1、32.1、34.1 全部覆盖
- [x] API required：decideApproval.bodyHash/decision、WorktreeCreate.baseBranch、DeliverInput.artifacts → UT-S03-01/02/19/25
- [x] DB CHECK/UNIQUE：tasks.key 子任务格式、sessions 并发索引、approvals 条件更新 → UT-S03-26/16/06

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S03-AC-01 | 正常：简单修复路径 60 秒内起会话，结束后线程有 PR 链接与子任务，Jira 收到评论（受信任约束） | ST-S03-01, UT-S03-26, ST-S03-16 |
| S03-AC-02 | 正常：出方案路径产出文档，可"按方案实现"不重新描述 | ST-S03-02, UT-S03-27, UT-S03-28 |
| S03-AC-03 | 正常：agent 轮换与交叉 review | ST-S03-01, UT-S03-14, UT-S03-15 |
| S03-AC-04 | 异常：路由目标离线则排队，不退回其他机器，上线后自动启动 | ST-S03-06, UT-S03-12 |
| S03-AC-05 | 异常：并发已满排队；分析类可改派另一家 | ST-S03-07, ST-S03-08, UT-S03-16, UT-S03-17 |
| S03-AC-06 | 异常：会话失败出三选一，worktree 保留 | ST-S03-14, ST-S03-15, UT-S03-29 |
| S03-AC-07 | 异常：worktree 终态 3 天回收，磁盘超阈值从最老删起，运行中不受影响 | ST-S03-17 |
