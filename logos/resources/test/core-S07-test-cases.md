# S07: 跟踪会话进展并在线程中介入 — 测试用例

> 输入：`core-S07-session-progress.md`（49 Step，8 EX）、`api/tasks.yaml`（postTaskMessage、getSessionLogs、stopSession、listTaskMessages）、`api/mcp.yaml`（report_progress、ask_user）、`api/worker-channel.yaml`（session.logs、session.resume、session.stop、session.state）、`database/schema.sql`（messages、questions、sessions）、PRD S07 验收条件
> 测试隔离：fake claude（支持 --bg / agents --json / logs / --bg --resume / stop，并按脚本调 MCP），fake lark-cli

## 一、单元测试用例

### 1.1 进展回写与日志（来源：mcp.yaml → ReportProgressInput；tasks.yaml → getSessionLogs；schema.sql → messages.log_from/log_to）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S07-01 | report_progress 写 progress 消息并刷新 last_progress_at | Step 1–3 | running 会话 | text 120 字 | messages kind=progress；sessions.last_progress_at 更新 |
| UT-S07-02 | 超过 200 字被截断并标记 | ReportProgressInput.text maxLength 200 | — | 260 字 | 存 200 字，payload.truncated=true |
| UT-S07-03 | progress 消息带 log_from/log_to 时间窗 | schema.sql → messages.log_from | 上一条 progress 在 T1 | 新 progress 在 T2 | log_from=T1，log_to=T2 |
| UT-S07-04 | getSessionLogs limit 超过 2000 被拒 | getSessionLogs limit maximum | — | limit 5000 | 422 |
| UT-S07-05 | getSessionLogs 经 worker 通道取片段并返回 truncated | Step 6–12 | fake claude logs 输出 600 行 | limit 400 | lines 长度 400，truncated=true |
| UT-S07-06 | runtime 离线时 getSessionLogs 503 | EX-8.1 | 离线 | GET logs | 503 RUNTIME_OFFLINE |
| UT-S07-07 | task token 与 taskKey 不符的 MCP 调用返回 -32001 | mcp.yaml → mcpRpc 说明 | token 绑定 T-1 | report_progress T-2 | JSON-RPC error -32001 |
| UT-S07-08 | 任务终态后 MCP token 失效 401 | mcp.yaml → mcpTaskToken | 任务 done | 任何调用 | 401 |

### 1.2 需要输入与回答（来源：mcp.yaml → AskUserInput/Output；tasks.yaml → postTaskMessage；schema.sql → questions）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S07-09 | ask_user 创建 open 问题、ask 消息，任务 waiting_input | Step 13–15 | running | ask_user | questions open expires_at=+30min；messages kind=ask；tasks.state waiting_input；notifications question |
| UT-S07-10 | ask_user timeoutMinutes 超过 30 被拒 | AskUserInput.timeoutMinutes maximum | — | 45 | 校验错误 |
| UT-S07-11 | postTaskMessage 有 open 问题时 delivery=answered 并唤醒 MCP | Step 21–28 | 挂起 ask_user | POST text | 202 delivery=answered；MCP 返回 answered=true answer=text answeredVia=panel；questions answered；tasks running |
| UT-S07-12 | postTaskMessage 无 open 问题时 delivery=resumed 下发 session.resume | Step 36–38 | 会话 done 无问题 | POST text | 202 delivery=resumed；worker 收到 session.resume |
| UT-S07-13 | runtime 离线时 delivery=queued 且消息标 queued | EX-37.1 | 离线 | POST text | 202 delivery=queued；messages.delivery queued |
| UT-S07-14 | 指定 questionId 回答特定问题 | postTaskMessage.questionId | 两个 open 问题 | POST 带 questionId=q1 | q1 answered，q2 仍 open |
| UT-S07-15 | 问题已答再答返回 409 但消息仍追加并 resume | EX-25.1 | q1 answered | POST 无 questionId | 409 QUESTION_ALREADY_ANSWERED；messages 新增；session.resume 下发 |
| UT-S07-16 | 飞书回复按 parent_id 匹配问题 | Step 23–24 | questions.feishu_message_id = m2 | 回放回复事件 parent m2 | 问题 answered answeredVia=feishu；回帖"已送入" |
| UT-S07-17 | 飞书回复非问题消息回帖引导 | EX-22.1 | parent 为审批消息 | 回放 | 回帖含"用 ✅/❌ 操作"；无变化 |
| UT-S07-18 | 问题 30 分钟超时 MCP 返回 timeout，状态保持 open | EX-13.1 | 注入时钟 | 推进 30 分钟 | AskUserOutput answered=false reason=timeout；questions.status 仍 open；tasks waiting_input |
| UT-S07-19 | 钩子 agent_needs_input 无对应问题时生成 origin=hook 问题 | EX-19.1 | 无 open 问题；fake logs 有片段 | session.state waitingFor=input source=hook | questions 1 行 origin=hook，text 含日志片段 |
| UT-S07-20 | text 超过 20000 被拒 | postTaskMessage text maxLength | — | 20001 | 422 |

### 1.3 完成、续接、停止、无进展（来源：Step 31–49；worker-channel.yaml → SessionState/SessionResume/SessionStop）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S07-21 | session.state done 更新 sessions 与 tasks，写事件 | Step 32–33 | running | state done source=hook | sessions done ended_at；tasks delivered（有产物）或 running→done 规则；events |
| UT-S07-22 | 续接用同一 sessionId：worker 先 `stop <短 id>` 再 `--bg --resume <完整 UUID>` | Step 40；claude 2.1.26x 实测（空闲进程仍在时直接 resume 会开副本） | fake claude 记录参数 | session.resume | fake 依次收到 `stop <短 id>` 与 `--bg --resume <UUID> "<text>"`；sessions.state running；输出含 "started a copy" 时报 RESUME 失败 |
| UT-S07-29 | 轮询到 claude state=blocked 上报需要输入，done 时先 stop 再报完成 | Step 19、31；EX-19.1 | fake claude `agents --json --all` 先返回 blocked 再返回 done | 轮询 | blocked 只触发一次 onWaiting；done 时 fake 收到 `stop <短 id>` 且 onExit(0)；中心收到 source=poll 的 waiting_input 时同样按 EX-19.1 推断问题 |
| UT-S07-23 | 续接失败 RESUME_FAILED → 收件箱三选一（fresh_session） | EX-40.1 | fake claude resume 非零 | session.resume | error RESUME_FAILED；tasks failed；retry mode=fresh_session 创建新会话同 worktree 且 prompt 含线程摘要 |
| UT-S07-24 | stopSession 幂等 | tasks.yaml → stopSession | 已 stopped | POST stop | 200 |
| UT-S07-25 | stopSession 使任务 paused 并保留 worktree | Step 44–46 | running | POST stop | sessions stopped；tasks paused；worktrees.state ready |
| UT-S07-26 | 10 分钟无进展广播 session.stale | Step 47–49 | last_progress_at = now-11min | tick(progress-watch) | events session.stale minutes=10 |
| UT-S07-27 | 30 分钟无进展推飞书一次且不自动停止 | EX-49.1 | now-31min；注入时钟 | tick ×2 | notifications alert 1 条；sessions 仍 running |
| UT-S07-28 | listTaskMessages 游标分页正序 | tasks.yaml → listTaskMessages | 250 条消息 | after 游标翻页 | 每页 ≤ 100，顺序正确，nextCursor 正确终止 |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S07-01 | 进展摘要展示与展开日志 | Step 1→12 | fake claude 脚本 report_progress ×2 并有 logs 输出 | 1 等两条 progress 2 GET /api/tasks/T-231/messages 3 GET /api/sessions/{id}/logs?from&to | messages 两条 kind=progress ≤200 字；logs 返回该时间窗行，truncated 正确；events message.new ×2 |
| ST-S07-02 | agent 提问，面板回复送入会话，会话继续到完成 | Step 13→34 | fake claude：ask_user("方案一还是二？") → 收到答案后 report_progress → deliver → 退出 | 1 等 ask 2 GET /api/inbox 含 question 3 POST /api/tasks/T-231/messages "方案二" 4 等完成 | 收件箱 questions 1 项后移除；MCP 收到 answer="方案二"；tasks 由 waiting_input 回 running；线程"已送入会话"；session.state done；产物卡出现 |
| ST-S07-03 | 飞书直接回复"需要你回答" | Step 22→30 | 同上；fake lark-cli 回放回复事件 | 回放 parent=问题消息 | 问题 answered via feishu；MCP 收到答案；回帖"已送入 T-231 的会话" |
| ST-S07-04 | 会话停止一小时后追加消息续接 | Step 35→41 | 会话 done；fake claude 支持 resume | POST messages "顺便把默认值改成 5s" | delivery=resumed；fake 收到 --bg --resume；线程"已恢复会话"；新 progress 出现 |
| ST-S07-05 | 人工停止会话 | Step 42→46 | running | POST /api/sessions/{id}/stop | fake claude 收到 stop；sessions stopped；tasks paused；worktree 保留 |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S07-06 | runtime 离线时展开日志 503 | EX-8.1 | dev 离线 | GET logs | 503 RUNTIME_OFFLINE |
| ST-S07-07 | 提问 30 分钟无人答，稍后回复走续接 | EX-13.1 | fake claude 在 timeout 后 report_progress 并退出；注入时钟 | 推进 30 分钟 → POST messages | MCP timeout；tasks waiting_input；收件箱条目保留；回复后 delivery=resumed 且 questions answered |
| ST-S07-08 | agent 未用 MCP 提问，钩子推断出问题 | EX-19.1 | fake claude 只在输出里提问并触发钩子 agent_needs_input | 等钩子 | questions origin=hook；收件箱有需要输入；回复后 session.resume（无 MCP 唤醒） |
| ST-S07-09 | 回复了待拍板消息被引导 | EX-22.1 | 飞书回放 parent=审批消息 | 回放 | 回帖含"用 ✅/❌ 操作"；无状态变化 |
| ST-S07-10 | 两通道都回答，第二条作为补充送入 | EX-25.1 | 挂起问题 | 先面板回复，再飞书回复 | 面板答案唤醒 MCP；飞书回复 → 回帖"已于…在面板回复"，消息仍追加并 resume |
| ST-S07-11 | runtime 离线时追加消息排队，上线后送入 | EX-37.1 | dev 离线 | POST messages → 注册 dev | 先 queued；注册后 pendingCommands 含 session.resume；消息 delivery=delivered |
| ST-S07-12 | 续接失败给三选一，以新会话继续 | EX-40.1 | fake claude resume 报会话不存在 | POST messages → POST retry fresh_session | RESUME_FAILED 事件；新会话 attempt+1，prompt 含线程摘要，同 worktree |
| ST-S07-13 | 30 分钟无进展告警但不停止 | EX-49.1 | fake claude 不回写；注入时钟 | 推进 10、30 分钟 | 10 分钟 session.stale；30 分钟 notifications alert 1 条，收件箱"查看日志 / 停止会话"，会话仍 running |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S07-14 [manual] | 真实 Claude Code 会话被 supervisor 停止一小时后 `--bg --resume` 恢复且上下文不丢 | Step 35→41 | 真实环境等待 1 小时后追加消息，观察会话记得之前内容 |
| ST-S07-15 [manual] | 真实 Notification 钩子 agent_needs_input / agent_completed 回调到 worker | Step 19、31 | 真实会话中观察 worker 日志收到钩子 |
| ST-S07-16 [manual] | 面板展开日志面板 200ms 内动画与"查看完整日志"链接 | Phase 2 S07 验收 | 人工观察 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件 AC-01/02/03 → ST-S07-01、ST-S07-02、UT-S07-21
- [x] Phase 1 异常验收条件 AC-04/05 → ST-S07-04、ST-S07-11
- [x] EX：8.1、13.1、19.1、22.1、25.1、37.1、40.1、49.1 全部覆盖
- [x] API required：postTaskMessage.text、AskUserInput.question、SessionResume.text → UT-S07-20、UT-S07-10（间接）、UT-S07-22
- [x] DB：questions 唯一 feishu_message_id 索引、messages.delivery CHECK → UT-S07-16、UT-S07-13

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S07-AC-01 | 正常：线程按时间显示 ≤200 字摘要，可展开对应时间段日志 | ST-S07-01, UT-S07-02, UT-S07-03, UT-S07-05 |
| S07-AC-02 | 正常：回答 agent 问题 10 秒内送入会话，状态回到运行中 | ST-S07-02, ST-S07-03, UT-S07-11 |
| S07-AC-03 | 正常：完成通知后线程出现完成摘要与产物，状态更新 | UT-S07-21, ST-S07-02 |
| S07-AC-04 | 异常：会话已被 supervisor 停止，追加消息以同一 ID 恢复且上下文不丢 | ST-S07-04, UT-S07-22, ST-S07-14 |
| S07-AC-05 | 异常：runtime 离线时追加消息排队，不在其他机器新开会话 | ST-S07-11, UT-S07-13 |
