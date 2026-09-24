# S04: 在 IM 频道用口语派活 — 测试用例

> 输入：`core-S04-channel-dispatch.md`（40 Step，9 EX）、`api/channels.yaml`（createChannel、postChannelMessage）、`api/tasks.yaml`（confirmDraft、cancelDraft、createTask）、`api/mcp.yaml`（lookup_jira、propose_task、ask_clarification、list_tasks）、`database/schema.sql`（channels、messages、task_drafts、sessions、jobs）、PRD S04 验收条件
> 测试隔离：fake claude 作为调度员（按脚本调 MCP），fake Jira，center runtime 由测试进程内 worker 模拟

## 一、单元测试用例

### 1.1 频道与消息校验（来源：channels.yaml → createChannel / postChannelMessage；schema.sql → channels.slug CHECK/UNIQUE）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S04-01 | slug 含大写或下划线被拒 | createChannel slug pattern | — | `Doris_Index` | 422 |
| UT-S04-02 | slug 超过 40 字符被拒 | slug maxLength | — | 41 字符 | 422 |
| UT-S04-03 | 重名频道 409 | schema.sql → channels.slug UNIQUE；EX-4.1 | 已有 doris-index | POST 同 slug | 409 CHANNEL_EXISTS |
| UT-S04-04 | 消息 text 为空被拒 | postChannelMessage text minLength 1 | — | `""` | 422 |
| UT-S04-05 | 消息 text 超过 20000 被拒 | text maxLength | — | 20001 字符 | 422 |
| UT-S04-06 | 用户消息先落库再处理 | S04 Step 9 | 调度员不可用 | POST 口语 | messages 1 行 kind=user；响应 202 handling=unavailable |

### 1.2 斜杠命令解析（来源：S04 EX-10.1；core-03 5.1 等价表）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S04-07 | `/task new --source CIR-19418 --repo selectdb/selectdb-core --path fix` 直出草案 | EX-10.1 | — | 该文本 | handling=command；task_drafts 1 行 origin=command，fields 齐全 |
| UT-S04-08 | `/task new` 缺 --path 时草案字段留空并高亮 | EX-10.1 | — | 缺 path | 草案 fields.path 为 null，payload.highlight 含 path |
| UT-S04-09 | `/task pause T-231` 执行暂停并回系统消息 | EX-10.1 | T-231 running | 该文本 | tasks.state paused；messages 新增 system |
| UT-S04-10 | 未知命令返回 422 并提示 | EX-10.1 | — | `/foo` | 422 details.command = foo，message 含"输入 / 查看列表" |
| UT-S04-11 | `/approve A-88` 等价 decide approve（原样） | 等价表 | A-88 pending | 该文本 | approvals approved via panel |

### 1.3 调度员会话生命周期（来源：S04 Step 11–17、37–40；schema.sql → idx_sessions_channel_dispatcher）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S04-12 | 无活跃调度员时拉起，路由到 center | Step 11–13 | center 在线 | 口语消息 | sessions 1 行 kind=dispatcher，channel_id 匹配，runtime=center |
| UT-S04-13 | 有活跃调度员时改为 session.resume | Step 13 说明 | 已有 running 调度员 | 口语消息 | 无新会话；下发 session.resume 文本 = 消息 |
| UT-S04-14 | 调度员提示词含最近 50 条频道消息与 runtime/仓库清单 | Step 13 | 频道 60 条消息 | 拉起 | prompt 含最后 50 条、在线 runtime 标签、已登记仓库 |
| UT-S04-15 | 空闲超过 30 分钟被回收 | Step 37–40 | 调度员 last_activity_at = now-31min | tick(dispatcher-idle) | 下发 session.stop reason=idle，sessions.state stopped |
| UT-S04-16 | 空闲 29 分钟不回收 | Step 38 | last_activity_at = now-29min | tick | 无 stop |

### 1.4 草案与确认（来源：mcp.yaml → ProposeTaskInput；tasks.yaml → confirmDraft/cancelDraft；schema.sql → task_drafts）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S04-17 | propose_task 缺 path 被拒 | ProposeTaskInput.required | — | 无 path | JSON-RPC 校验错误 |
| UT-S04-18 | propose_task 写草案与 draft_card 消息 | Step 27–30 | — | 有效入参 | task_drafts 1 行 open；messages kind=draft_card ref_type=draft |
| UT-S04-19 | confirmDraft 创建任务并挂到该频道，pick_targets 只记录 | Step 32–34 | open 草案含 pick | POST confirm | tasks.channel = 该频道，state triaging，pick_targets = [branch-selectdb-doris-3.1]；draft status confirmed，task_id 指向新任务 |
| UT-S04-20 | confirmDraft 的 edits 覆盖草案字段 | confirmDraft edits | open 草案 repo=A | edits.repo = B | tasks.repo_name = B，repo_source = manual |
| UT-S04-21 | 已取消草案 confirm 返回 409 | EX-34.1 | 草案 cancelled | POST confirm | 409 DRAFT_NOT_OPEN |
| UT-S04-22 | 草案 24 小时过期 | schema.sql → task_drafts.expires_at | 注入时钟 +25h | confirm | 409 DRAFT_NOT_OPEN，status expired |
| UT-S04-23 | cancelDraft 幂等 | cancelDraft | open 草案 | 两次 cancel | 200 两次，status cancelled |
| UT-S04-24 | ask_clarification candidates 超过 5 个被拒 | AskClarificationInput.candidates maxItems 5 | — | 6 个 | 校验错误 |
| UT-S04-25 | lookup_jira 转系统作业并等待结果 | Step 18–26 | dev 在线 vpn:jira；fake Jira 返回单 | 调用 | jobs kind=jira-lookup 完成；MCP 返回 found=true 与 issue 摘要；耗时 < 60 秒 |
| UT-S04-26 | lookup_jira 无 vpn:jira runtime 返回 SOURCE_UNAVAILABLE | EX-20.1 | 无此标签 runtime | 调用 | MCP 返回 error SOURCE_UNAVAILABLE，无 jobs 排队 |
| UT-S04-27 | 同一来源已有未完结任务 → 草案标出已有任务，确认默认 409，force 才新建 | channels.yaml → confirmDraft.force；core-02 §5.1 #13；实验环境实测（CIR-30103 重复建出 T-6） | 已有 pending_decision 任务 source=CIR-19418 | /task new 同来源；confirm；confirm force；已有任务 done 后再建 | 草案卡 payload.existing 指向已有任务；confirm 409 DUPLICATE_SOURCE 且草案仍 open；force 201；已完成的任务不算重复 |
| UT-S04-28 | 草案确认 / 取消后，草案卡消息回写状态 | core-02 §5.1 #13 | 两份 open 草案 | 一份 confirm，一份 cancel | 草案卡 payload.status 分别为 confirmed（带 taskKey）与 cancelled；写 message.updated 事件 |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S04-01 | 建频道、一句话到草案卡、确认建任务 | Step 1→36 | center 在线；dev 在线 vpn:jira；fake Jira 有 CIR-19418；fake claude 调度员脚本：lookup_jira → propose_task | 1 POST /api/channels 2 POST messages "把 CIR-19418 修了，顺便 pick 到 branch-selectdb-doris-3.1" 3 等 draft_card 4 POST /api/drafts/{id}/confirm | 频道 201；202 handling=dispatcher；events 有 channel.system"拉起中"；30 秒内 messages 有 draft_card，fields.source=CIR-19418、repo=selectdb/selectdb-core、path=fix、pickTargets=[branch-selectdb-doris-3.1]；confirm 后任务 triaging 且 channel=doris-index，events thread.created |
| ST-S04-02 | 调度员空闲 30 分钟回收并在下次输入时重建 | Step 37→40 + Step 13 | ST-S04-01 后；注入时钟 | 推进 31 分钟 → tick → 再发一句口语 | 旧会话 stopped；新会话 running 且 prompt 含之前的频道消息 |
| ST-S04-03 | 第二句话追加到活跃调度员 | Step 13（resume 分支） | 调度员 running | 再 POST 一句 | 无新会话；session.resume 下发；调度员回写新草案 |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S04-04 | 频道重名 | EX-4.1 | 已有频道 | POST 同 slug | 409 CHANNEL_EXISTS |
| ST-S04-05 | 斜杠命令直出草案不经调度员 | EX-10.1 | 无调度员会话 | POST `/task new --source CIR-19420 --repo selectdb/selectdb-core --path fix` | 202 handling=command 且 draft 非空；sessions 无 dispatcher；后续 confirm 同主路径 |
| ST-S04-06 | 调度员不可用提示命令且不自动重放 | EX-13.1 | center 上两家并发已满 | POST 口语 → 释放并发 | 202 handling=unavailable，hint 含 `/task new`；events channel.system warn；释放后无自动重放（sessions 无新 dispatcher，messages 无新 draft） |
| ST-S04-07 | 无 vpn:jira runtime 时调度员改为澄清 | EX-20.1 | dev 离线；fake 调度员在 lookup 失败后 ask_clarification | POST 口语 | messages kind=clarification 文本含"查不到 Jira"；无草案 |
| ST-S04-08 | 引用不存在走澄清并列候选，点候选后出草案 | EX-22.1 | fake Jira 404 CIR-99999；有 5 个最近任务 | POST "把 CIR-99999 修了" → POST 消息 replyToCandidate=CIR-20001 | 第一次：clarification 消息 payload.candidates 长度 ≤ 5，无草案；第二次：draft_card 出现 |
| ST-S04-09 | 一句话两个任务两张草案 | EX-27.1 | fake Jira 有 CIR-19418 与 CIR-19420；调度员脚本 propose ×2 | POST "CIR-19418 和 CIR-19420 都修一下" | task_drafts 2 行 open；两次 confirm 各建任务 |
| ST-S04-10 | 语义不明只澄清一轮 | EX-27.2 | 调度员脚本 ask_clarification | POST "看看那个索引的问题" | clarification 出现；用户回答后调度员必须 propose 或明确无法处理（脚本断言 MCP 调用序列） |
| ST-S04-11 | 调度员 60 秒无响应给出超时提示但会话继续 | EX-30.1 | fake 调度员 90 秒后才 propose；注入时钟 | POST 口语 → 推进 60 秒 → 推进 30 秒 | 60 秒时 channel.system 含"响应超时"；90 秒时 draft_card 正常出现，会话未被停止 |
| ST-S04-12 | 草案取消或过期后确认返回 409 | EX-34.1 | 草案 open | cancel 后 confirm；另一草案推进 25 小时后 confirm | 两次 409 DRAFT_NOT_OPEN |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S04-13 [manual] | 真实 Claude Code 调度员对真实 Jira 单给出合理草案 | Step 15→30 | 在中心机真实环境说一句话，人工核对草案字段与查证行为符合 core-04 行为规范 |
| ST-S04-14 [manual] | 命令面板 `/` 弹出与 Tab 补全的交互 | Phase 2 S04 验收 | 人工在面板操作 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件 AC-01/02/03 → ST-S04-01、ST-S04-05、ST-S04-02
- [x] Phase 1 异常验收条件 AC-04/05 → ST-S04-10、ST-S04-09
- [x] EX：4.1、10.1、13.1、20.1、22.1、27.1、27.2、30.1、34.1 全部覆盖
- [x] API required：createChannel.slug、postChannelMessage.text、ProposeTaskInput.path → UT-S04-01/04/17
- [x] DB UNIQUE/CHECK：channels.slug、task_drafts.status/expires → UT-S04-03、UT-S04-21/22

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S04-AC-01 | 正常：一句话 30 秒内变成带 pick 目标的草案，创建后收件箱出分流卡 | ST-S04-01, UT-S04-19, UT-S04-25 |
| S04-AC-02 | 正常：斜杠命令兜底不经 LLM | ST-S04-05, UT-S04-07, UT-S04-08 |
| S04-AC-03 | 正常：调度员空闲 30 分钟回收，再次输入重新拉起并带历史 | ST-S04-02, UT-S04-15, UT-S04-16 |
| S04-AC-04 | 异常：语义不明确时澄清并列候选，不创建任务 | ST-S04-10, ST-S04-08, UT-S04-24 |
| S04-AC-05 | 异常：一句话对应多个任务生成多张草案 | ST-S04-09 |
