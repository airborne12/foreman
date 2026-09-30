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
| UT-S03-32 | 拍板可覆盖基线分支，落到任务与决策记录 | approvals.yaml → decideApproval.overrides.baseBranch | 分流卡待拍板 | decide approve 带 overrides.baseBranch | tasks.base_branch 与 decision.baseBranch 为该分支；modified=true（覆盖即算修改，不计入信任） |
| UT-S03-33 | 构建环境按基线分支匹配：同名 > 最长前缀 > default > 缺失 | worker-channel.yaml → buildEnv 说明 | build_env 配同名档、前缀档与 default | pickBuildEnv 传入不同分支 | 依次命中同名档、前缀档、default；无 default 时返回缺失（由 worktree.ready 回报 buildEnvMissing，中心据此降级） |
| UT-S03-34 | 基线变了就按新基线重建 worktree；有未提交改动时拒绝 | worker-channel.yaml → WorktreeCreate.resetToBase；实验环境 T-1 实测 | 按 master 建过 worktree；另有分支 rel | create(baseBranch=rel, resetToBase)；再改一个受控文件后重建 | 重建后工作区内容来自 rel、reused=false；有未提交改动时报「未提交」拒绝，文件保持原样 |
| UT-S03-35 | 主仓库只有远端跟踪分支时，基线解析为 origin/<分支> | worktree.ts → resolveBaseRef；T-6 实测 | 只有 refs/remotes/origin/branch-x | resolveBaseRef / create | 本地分支原样返回；远端分支返回 origin/branch-x；worktree 可建出 |
| UT-S03-36 | 已有 worktree 的基线与任务不一致时，派发改为按新基线重建 | S03 Step 11；实验环境 T-1 实测 | 任务 base_branch=4.1，已有 ready worktree 基于 4.0 | dispatchTask | 下发 worktree.create（baseBranch=4.1，resetToBase=true），不直接复用；线程写明原基线与重建原因 |
| UT-S03-37 | 会话结束但本会话没有产物 → 任务暂停进收件箱，回复续接后原因清除 | S03 Step 27；core-02 §5.1 平台行为；实验环境 T-2 实测（PR 被否决后误标已交付） | running 任务 + implement 会话，最后一条进展「建 PR 没被批准」 | session.state done；再 POST 任务消息 | 任务 paused，queue_reason 以「人工处理：会话结束但没有产物」开头并带最后进展；收件箱 failures 含该任务；回复后下发 session.resume，任务回到 running、原因清空 |
| UT-S03-38 | 代码任务只派给登记了该仓库的 runtime；都没有时进收件箱说明原因 | routing.ts；实验环境 T-3 实测（改选 apache/doris 仍派到 dev） | dev 只登记 selectdb-core | routeTask 各分支；dispatchTask(repo=apache/doris) | 选登记了仓库的 runtime；无人登记返回 missingLabels repo:x；未上报仓库的旧 runtime 不过滤；派发时任务保持 queued、原因「人工处理：没有 runtime 登记仓库」，不发 worktree.create |
| UT-S03-39 | 拍板改选没有 runtime 登记的仓库 → 422 REPO_UNAVAILABLE | approvals.yaml → decideApproval；core-02 §5.1 #4 | 仓库待确认的分流卡，dev 登记 selectdb-core | overrides.repo=apache/doris；再改 selectdb-core | 422 REPO_UNAVAILABLE，消息列出已登记仓库，审批仍 pending；改选已登记仓库 200；未改选时校验分流卡上的仓库（卡上 apache/doris 原样批准也 422，T-77 实测），否决不受影响 |
| UT-S03-40 | 降级分流卡从面板重新定位 | tasks.yaml → relocate；core-02 §5.1 #6 | 分流卡 degraded | POST /api/tasks/{key}/relocate 两次；对 running 任务调用 | 202，下发 worktree.create 并建 planned code_locate 会话，线程写「已从面板发起重新定位」；重复调用不重复派；已拍板任务 409 INVALID_STATE；重新定位时清空卡片与任务上旧的基线结论 |
| UT-S03-41 | 停止会话后从暂停恢复，续接原会话 | S07 Step 46；实验环境实测（恢复只改状态，任务空转） | running 任务 + 会话，session.state stopped | POST /api/tasks/{key}/resume | 200 state running；下发 session.resume 给原会话，会话回到 running |
| UT-S03-42 | 收件箱与任务带出 Jira 优先级；runtime 列表带出仓库 | core-02 §5.1 #2、#4 | 分流卡任务 context_packs.jira.priority=P0 | GET /api/inbox、/api/tasks/{key}、/api/runtimes | approvals[].priority=P0；任务 priority=P0；runtime.repos 列出登记仓库 |
| UT-S03-43 | worktree 已被实现会话用过时，基线不同也原样复用 | S03 Step 11；UT-S07-23 回归（重试时误触发重建） | 任务基线 4.1，ready worktree 基于 main 且已被 implement 会话用过 | dispatchTask(attempt 2) | 直接下发 session.start，不发 worktree.create，线程不写「按新基线重建」 |
| UT-S03-44 | agent 启动失败换家时守并发上限，另一家满了就排队 | EX-15.1 + EX-7.2；2026-09-29 生产实测（claude 目录未信任全部起不来，3 个代码定位换到 codex，codex 跑到 6/3） | dev 上 codex 已 3/3 运行 | claude 实现会话、claude 代码定位会话各报 AGENT_START_FAILED | 实现任务回到 queued、agent=codex、原因「排队：claude 启动失败…」；代码定位写回 queued 的 code-locate 作业；codex 活跃会话数保持 3 |
| UT-S03-45 | 文本会话的占位 cwd 改到专用目录 | worker-channel.yaml → SessionStart.cwd；2026-09-29 claude 2.1.284 起 --bg 只在被信任目录启动，调度员落在 /tmp 起不来 | 临时 FOREMAN_HOME | textWorkspace(cwd=/tmp)；textWorkspace(cwd=worktree) | /tmp 换成 <home>/workspace 且目录已建；worktree 路径原样返回 |
| UT-S03-46 | 代码定位会话结束未回写时，已有的降级卡也刷新原因 | S01 EX-22.1；2026-09-29 生产实测（会话已跑完，卡上仍写「排队中：并发已满」） | 任务已有降级分流卡（原因「代码定位排队中」），code_locate 会话 running | session.state done（未 deliver） | 分流卡原因改为「代码定位失败：会话结束但未回写分流结果」，审批仍 pending 且只有一条 |
| UT-S03-47 | claude 工作区信任只写 worker 管理的目录，保留其他内容，坏文件不覆盖 | core-03 §5.2 claude 工作区信任 | 临时 .claude.json 含其他顶层键与已有项目条目（0600） | isManagedPath 各边界；setClaudeTrust 标记 / 重复标记 / 取消；写坏 JSON 后再标记；runGc onRemoved | 仅 worktreeRoot 子目录与精确列出的目录算管理范围（根本身、同前缀兄弟目录不算）；标记补齐默认字段并保留已有字段与其他顶层键，权限仍 0600，重复标记返回未改动；取消删除条目；坏文件抛错且原样；目录存在并被删除时才回调 |
| UT-S03-48 | worker 起 claude 前自动信任自己建的 worktree；被冲掉时补标重试；范围外不碰 | core-03 §5.2；2026-09-29 实测（git worktree 不继承父目录信任） | 真实 Worker 接中心，假 claude 按配置文件检查信任，首次启动时模拟条目被冲掉 | session.start（cwd=worktreeRoot/T-255）；再对范围外目录 session.start | 首次报未信任后补标重试成功，会话进入 running，条目在；范围外目录不写条目、只尝试一次 |
| UT-S03-49 | 定位结论入库前兜底：短仓库名补全、非法基线清空并留给拍板 | S01 Step 12–23；mcp.yaml → TriageArtifact；2026-09-29 生产实测（claude 交 selectdb-core 短名致路由为空；codex 基线写「3.1 or 4.0」） | 已登记 apache/doris、selectdb/selectdb-core；dev 在线 | normalizeRepo / isBranchName / normalizeTriage 各边界；MCP deliver 短名 + 非法基线 | 短名与大小写差异唯一对上时补全，歧义或对不上原样；非法基线清空并把原文追加到建议；分流卡仓库为全名、默认 runtime=dev、基线为空；定位提示词列出已登记仓库；任务上遗留的非法基线不被沿用 |
| UT-S03-50 | 代码定位作业随会话结束关闭；名额满时重新定位进队列，不因遗留作业 500 | S01 EX-17.1 / EX-7.2；2026-09-29 生产实测（批量重新定位，名额满时 5 张单 500：遗留的已派发作业撞 dedupe 唯一索引） | 一张单有已派发作业与 code_locate 会话；dev 上 claude、codex 各 3/3；另一张降级单有 3 小时前遗留的已派发作业 | session.state done；POST relocate 两次 | 会话结束后作业 succeeded；relocate 202，遗留作业改 skipped、新作业 queued；重复点击不重复排队 |
| UT-S03-51 | 任务上的短仓库名在定位建 worktree 前补全；降级更新的线程提示写「未完成」 | S01 Step 12；2026-09-29 T-71 实测（任务 repo 被早先的短名 selectdb-core 覆盖，重新定位建 worktree 报「未配置仓库」；线程却写「代码定位已补齐」） | 待拍板任务 repo_name=selectdb-core，dev 登记 selectdb/selectdb-core | relocate；再以降级结论 emitTriage | worktree.create 的 repo 为全名且任务 repo_name 被更正；线程提示为「代码定位未完成：<原因>」 |
| UT-S03-52 | 同一会话重复申请同类审批时接着等原审批，不建重复 | mcp.yaml → request_approval；2026-09-29 T-81 实测（claude 60 秒超时重试，建出重复的 A-90/A-91） | implement 会话 | 同一会话连续两次 request_approval(create_pr)；再申请 jira_comment | 两次返回同一 approvalKey，create_pr 审批只有 1 条且 pending；不同类动作单独建 |
| UT-S03-53 | 会话结束时本会话还有待批审批 → 任务等待审批，不算「没产物」 | S03 EX-22.1；T-81 实测（会话超时结束后被标成「需要处理」，与待批审批并存） | implement 会话已发起 create_pr 审批且未决 | session.state done | 任务 waiting_approval、无 queue_reason；线程写「等待 A-x 审批：批准后自动续接」；收件箱无失败项、有该审批 |
| UT-S03-54 | worker 重启后恢复会话记录，等审批的会话仍能续接、不被判失联 | core-03 §5.2 会话记录落盘；2026-09-29 T-81 实测（发布 worker 后会话只在内存，批准后续接必然失败） | 真实 Worker 接中心、假 codex adapter | 起会话 → 停 worker → 同一配置目录再起 worker → session.resume | sessions.json 存在且 0600、含会话；新 worker 恢复该会话并重新盯住运行中的会话；对账后会话不是 lost；续接调用 adapter.resume（原 agentSessionId） |
| UT-S03-55 | 批准后续接已结束的会话失败 → 进失败卡，不假装在跑 | S03 EX-22.1 + S07 EX-40.1；2026-09-29 T-81 / A-90 实测（续接失败被静默丢弃，任务一直显示运行中） | implement 会话发起 create_pr 后结束，任务 waiting_approval | 面板批准；worker 回 RESUME_FAILED | 下发 session.resume（文本含「已批准」）；任务 failed，失败卡选项含 fresh_session；不往频道送 approval_decided_no_waiter（不拉调度员） |
| UT-S03-56 | review 子任务回写结论（kind=review），交 pr 被明确拒绝；review worktree 沿用父任务基线 | S03 Step 29；0003 迁移；2026-09-29 T-81.2 实测（交 pr 撞 tasks_key_check、worktree 落在仓库默认基线） | 父任务 base_branch=branch-hotfix-x，review 子任务 queued | dispatchTask(review)；review 会话 deliver pr；再 deliver review | worktree.create 基线为父任务的；交 pr 报错且提示改用 kind=review；review 产物落库含 verdict / mustFix / suggestions，不派生孙任务；父任务线程出现结论摘要 |
| UT-S03-57 | 任务换了仓库时不复用别的仓库建的工作区 | worker-channel.yaml → WorktreeReady.repo；2026-09-29 T-77 实测（定位工作区来自 selectdb-core，记录却写 apache/doris，派发会在错的仓库里改） | 两个本地 git 仓库共用 worktreeRoot；任务 repo=apache/doris，已有 ready 工作区记为 selectdb-core | createWorktree 先 A 后 B 再 B；dispatchTask；worker 回 worktree.ready(repo) | B 不复用 A 的路径而另建（belongsTo 核对 git common dir），再建复用 B 自己的；中心不复用其他仓库的工作区、下发 worktree.create(repo=apache/doris)，并按回报的 repo 记录 |
| UT-S03-58 | 重连对账不把刚派发的 planned 会话判失联；实现 worktree 就绪但会话不在时不擅自起代码定位 | S05 Step 16 + S01 Step 15；2026-09-29 T-77 实测（worker 上线补派的同一刻被判失联，worktree 到了又起了一遍定位、打回待拍板） | dev 上一个 planned、一个 running 实现会话 | session.list 空清单；再对无 planned 会话的实现 worktree 发 worktree.ready | running 的判 lost、planned 的保持；不创建 code_locate 会话，线程写「等它的会话已不在」 |
| UT-S03-59 | git-publish 在工作区提交、推到 fork、建 PR；子模块指针不提交；PR 已存在取回链接；无改动报 NOTHING_TO_PUBLISH | worker-channel.yaml → JobRun git-publish；2026-09-30 T-77 实测（codex 沙箱 .git 只读，agent 无法提交推送） | 本地 origin 裸库（含 .gitmodules 登记的 sub 目录）、fork 裸库；工作区改了 README 与 sub/f；gh 用假命令 | gitPublish 两次；另一个只改 sub/f 的工作区再 gitPublish | 第一次提交只含 README、推到 fork 的 foreman/T-271，gh pr create 参数为 --repo o/r --base master --head me:foreman/T-271，返回 created=true；sub/f 留在工作区；第二次 gh 报已存在 → 取回链接、created=false；只改子模块的报 NOTHING_TO_PUBLISH |
| UT-S03-60 | 平台代做 git：create_pr 审批带执行参数，批准后派 git-publish、交付 PR，不续接会话 | mcp.yaml → request_approval（create_pr 由平台执行）；S06 Step 20；S03 Step 27–30 | dev 声明 git-publish、仓库配 pushRemote=fork；会话绑定就绪 worktree | request_approval(create_pr) 等待超时；会话结束；面板批准；worker 回 job.result ok | 审批 payload.executor=center 且 publish 含 runtime/path/repo/base/branch/pushRemote；会话结束后任务 waiting_approval；批准后下发 git-publish（带标题与正文）；成功后任务 delivered、pr_url 与分支落库，生成 PR / review 子任务，动作 succeeded；review worktree 派出、Jira 回写待批；不发 session.resume |
| UT-S03-61 | 平台建 PR 失败 → 审批可重试、带错误；重试接口重新执行成功 | approvals.yaml → retryApproval；S06 EX-20.1 | 同 UT-S03-60，agent 阻塞等待审批 | 面板批准；worker 回 job.result 失败；POST /api/approvals/{key}/retry；worker 回成功；再次 retry | MCP 返回 approved 且 note 提示不用做 git 操作；失败后审批 failed、retryable、payload.error 含 PUSH_FAILED，出现在收件箱，线程写「执行失败」；重试返回 200、动作 succeeded，审批回到 approved 并清掉 retryable/error，pr_url 更新；再次重试 409 |
| UT-S03-62 | git-publish 执行期间 worker 不被卡住，取日志照常秒回 | worker-channel.yaml → session.logs、JobRun git-publish；2026-09-30 A-96 实测（同步推送 doris 83 秒，面板取日志报「dev 未在 15 秒内返回日志」） | 真实 Worker 实例，仓库配 pushRemote=fork；工作区有改动；PATH 里的 gh 睡 3 秒再返回 | 下发 git-publish；0.8 秒后发 session.logs | 注册能力含 git-publish；session.logs 在 1.5 秒内返回 session.logs.result；随后提交推到 fork 的 foreman/T-274 |
| UT-S03-63 | 换仓库 / 基线重来：停掉在跑的会话、作废旧审批、按新仓库派全新会话 | tasks.yaml → restartTask；2026-09-30 T-83（影响版本 5.0.0 却在 selectdb-core 上修） | dev 登记 selectdb-core 与 apache/doris；任务 waiting_approval、在 selectdb-core / branch-selectdb-doris-5.0-incr，有 running 实现会话与待批 create_pr；上下文包 versionTarget=apache/doris master | 对 pending_decision 任务 restart；用未登记仓库 restart；restart {repo: apache/doris, baseBranch: master}；worker 回报旧会话 stopped | 409；422；202，worker 收到 session.stop，旧会话 stopped，create_pr 审批 expired 且不在收件箱；任务改为 apache/doris / manual / master / pick []；下发 worktree.create(repo=apache/doris, base=master)，新会话 attempt=2；线程写明停止与作废；旧会话 stopped 回报后任务仍是 queued |
| UT-S03-64 | 公开仓库的 create_pr 文案必须英文、不带内部单号，否则退回改写 | mcp.yaml → request_approval；center.yaml public_repos / sources.jira.internal_projects；2026-09-30 T-83（apache/doris PR 描述是中文且写了 DORIS-29301） | 任务仓库 apache/doris、来源 DORIS-29301；另一任务仓库 selectdb-core | request_approval(create_pr)：中文正文；带 DORIS-29301 / CORE-6212 的英文正文；合规英文正文；selectdb-core 任务用中文 | 前两次返回错误（含中文 / 含内部 Jira 单号）且不建审批；合规的建审批；非公开仓库不受限 |
| UT-S03-65 | 工作区的 custom_env.sh 以主仓库的为底，再叠加 build_env 覆盖项 | worker-channel.yaml → worktree.create buildEnv；2026-09-30 工作区只写了 DORIS_THIRDPARTY，缺主仓库里的 JAVA_HOME / Maven / 工具链 | 主仓库 custom_env.sh 含 JAVA_HOME、DORIS_TOOLCHAIN 与旧 DORIS_THIRDPARTY | createWorktree(buildEnv.DORIS_THIRDPARTY)；改主仓库 custom_env.sh 后再次 createWorktree（复用） | 工作区含主仓库各行，DORIS_THIRDPARTY 只有一行且为覆盖值；复用时随主仓库刷新，覆盖项仍只一行 |
| UT-S03-30 | claude --bg 启动参数、工具黑名单与会话 id 解析 | S03 Step 15；claude 2.1.26x 实测 | fake claude：`--bg` 输出 `backgrounded · 3f171235 · T-231-implement`，`agents --json --all` 返回该短 id 与完整 sessionId；配置 disallowedTools | session.start | 参数含 `--permission-mode auto`、`--strict-mcp-config`、`--mcp-config=<json>`、`--disallowedTools=<逗号分隔>`（都带 =，变长参数用空格写法会吞掉 prompt），prompt 仍是最后一个参数；agentSessionId 为完整 UUID，shortId 为 3f171235；foreman MCP 服务带 timeout=35 分钟（阻塞式审批 / 提问最长 30 分钟，claude 默认 60 秒超时，T-81 实测） |
| UT-S03-31 | codex 启动带 workspace-write 沙箱，续接不带 -C | S03 Step 15；codex exec resume --help | — | codexStartArgs / codexResumeArgs | 启动含 `-C <cwd>` 与 `sandbox_mode="workspace-write"`；续接以 `exec resume` 开头、不含 `-C`、含 MCP 配置，最后两个参数为 threadId 与文本；启动与续接都带 `mcp_servers.foreman.default_tools_approval_mode="approve"`（codex 0.158 起 MCP 工具默认要审批，后台 never 策略下会全部被拒，2026-09-29 生产实测）；带 `mcp_servers.foreman.tool_timeout_sec=2100` |

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
