# S02: 飞书消息显式入库 — 测试用例

> 输入：`core-S02-feishu-intake.md`（17 + 13 Step，7 EX）、`api/approvals.yaml`（candidates intake/dismiss、Candidate）、`api/mcp.yaml`（CandidatesArtifact）、`database/schema.sql`（feishu_events、source_items、tasks、context_packs、candidates、notifications）、PRD S02 验收条件
> 测试隔离：fake lark-cli（event +subscribe 回放 NDJSON；im 子命令写 JSON 文件），fake claude 脚本

## 一、单元测试用例

### 1.1 事件解析与过滤（来源：S02 Step 2–4；schema.sql → feishu_events PK）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S02-01 | reaction 事件解析出 messageId / operator / emoji | S02 Step 3 | — | 一行 `im.message.reaction.created_v1` NDJSON | intake.event 字段齐全 |
| UT-S02-02 | 非 owner open_id 的表情被忽略并记 ignore_reason | S02 EX-4.1 | owner = ou_A | operator = ou_B | 不建任务；feishu_events.handled = ignored，ignore_reason = not_owner |
| UT-S02-03 | 非入库表情被忽略 | S02 Step 4 | intake_emoji = PUSHPIN | emoji = THUMBSUP | ignored，reason = emoji_mismatch |
| UT-S02-04 | operator_type 非 user 被忽略 | Phase 2 core-04 2.1 | — | operator_type = app | ignored，reason = not_user |
| UT-S02-05 | 同 event_id 重放只处理一次 | schema.sql → feishu_events PK | 已处理 evt-1 | 再收 evt-1 | 主键冲突被吞，无副作用 |
| UT-S02-06 | @机器人带引用时以被引用消息为原文 | S02 Step 7 | — | mention 事件含 quotedMessageId | fetchContext 的 messageId = quotedMessageId，补充说明 = @ 文本 |
| UT-S02-07 | @ 的不是机器人自身 open_id 被忽略 | S02 Step 4 | bot open_id = ou_bot | mention ou_other | ignored |

### 1.2 入库与回帖（来源：schema.sql → source_items UNIQUE、tasks；S02 Step 11–14）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S02-08 | 飞书入库任务 source_type = feishu 且落 feishu 默认频道 | S02 Step 11 | — | 有效事件 | tasks.source_type = feishu，channel.slug = feishu，repo_source = llm，repo_name null |
| UT-S02-09 | 上下文包 conversation 含前后各 20 条 | S02 Step 7–10 | fake lark-cli 返回 45 条 | 入库 | conversation 长度 41（原消息 + 前 20 + 后 20） |
| UT-S02-10 | 上下文读取失败时 partial = true 且任务照建 | S02 EX-8.1 | fake lark-cli messages-get 失败 | 入库 | context_packs.partial = true；tasks 存在；jobs 有 context-retry 作业 |
| UT-S02-11 | 回帖文本含任务 key 与面板链接 | S02 Step 12 | — | 入库 T-232 | notifications.kind = intake_ack，text 含 "T-232" 与 `/c/feishu/t/T-232` |

### 1.3 候选扫描（来源：approvals.yaml → Candidate；schema.sql → candidates UNIQUE、CHECK；S02 Step 18–30）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S02-12 | 同 message_id 候选二次写入被忽略 | schema.sql → candidates UNIQUE | 已有候选 m1 | deliver candidates 含 m1 | 行数不变 |
| UT-S02-13 | confidence 非法（>1）被拒 | mcp.yaml → CandidatesArtifact.confidence | — | confidence 1.2 | 校验错误 |
| UT-S02-14 | 候选 dismiss 幂等且状态为 dismissed | approvals.yaml → dismissCandidate | open 候选 | 两次 dismiss | 200 两次，status = dismissed，decided_at 非空 |
| UT-S02-15 | 已处理候选再 intake 返回 CANDIDATE_NOT_OPEN | approvals.yaml → intakeCandidate 409 | 候选已 dismissed | intake | 409 CANDIDATE_NOT_OPEN |
| UT-S02-16 | 候选扫描过滤机器人自己的消息与已入库消息 | S02 Step 22 | 消息列表含 bot 发的与已入库的 | 组装扫描输入 | 两类消息不在 prompt 输入中 |
| UT-S02-17 | 候选扫描路由到 text 类型 → center | S02 Step 23、routing.text | center 在线 | 派会话 | sessions.runtime = center，kind = candidate_scan |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S02-01 | 群消息打 📌 入库并走到分流卡 | Step 1→17（含 S01 Step 12→31） | fake lark-cli 回放 owner 的 📌 事件并能返回上下文；dev 在线；fake claude deliver triage（repo confidence 0.82） | 1 回放事件 2 等待入库与回帖 3 等待分流卡 | 5 秒内 notifications 有 intake_ack；tasks 1 行 channel=feishu；context_packs.conversation 长度 41；triage_cards.repo_name = selectdb/selectdb-core；收件箱有待拍板 |
| ST-S02-02 | @机器人引用消息派活 | Step 1→17 | 回放 mention 事件（引用 m0，文本"看一下这个超时"） | 同上 | context_packs.source_text = m0 正文，summary 含补充说明；其余同 ST-S02-01 |
| ST-S02-03 | 候选扫描只进面板不推飞书 | Step 18→30 | fake lark-cli 返回 5 条增量消息；fake claude deliver 2 条候选 | 1 注入 tick(candidate-scan) 2 等待 3 GET /api/inbox | candidates 2 行 open；inbox.candidates 长度 2；notifications 无新记录；events 有 candidates.updated |
| ST-S02-04 | 候选一键入库走主路径 | Step 30 → Step 5 | ST-S02-03 后 | POST /api/candidates/{id}/intake | 201 返回任务；candidates.status = intaken 且 task_id 指向新任务；后续同 ST-S02-01 |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S02-05 | 他人打表情无反应 | EX-4.1 | 回放 operator = 同事 | 事件到达 | 无任务、无 notifications；feishu_events ignored |
| ST-S02-06 | 同一消息重复打表情回"已存在" | EX-5.1 | ST-S02-01 后 | 再回放同 messageId 的 📌 | tasks 不变；notifications 新增 reply 含"已存在 T-" |
| ST-S02-07 | 同一消息重复标记且原任务 paused 时出现恢复条目 | EX-5.1 副作用 | 任务已 paused | 再回放 📌 | events 含"用户再次标记"；收件箱出现恢复条目 |
| ST-S02-08 | 上下文读取失败仍建任务并稍后补齐 | EX-8.1 | fake lark-cli 首次 messages-get 失败，5 分钟后成功；注入时钟 | 回放事件 → 推进 5 分钟 | 先 partial=true、回帖含"上下文读取失败"；补齐后 partial=false，conversation 非空；重试次数 ≤ 3 |
| ST-S02-09 | 回帖失败不影响任务且标注未送达 | EX-13.1 | fake lark-cli reply 失败 | 回放事件 | tasks 存在；notifications intake_ack failed 重试 3 次；线程首条事件 payload 含 feishu_ack_failed |
| ST-S02-10 | 候选扫描额度不足本轮跳过 | EX-23.1 | 两家 agent 并发已满 | tick(candidate-scan) | jobs.status = skipped，error_code = QUOTA；无候选、无通知 |
| ST-S02-11 | 候选扫描会话超时无候选，三轮后标黄 | EX-26.1 | fake claude 不回写；注入时钟 | 3 次 tick 各推进 10 分钟 | 每轮会话 stopped；第 3 轮后 source_health 或 runtime 状态 payload 含 candidate_scan_failing = 3 |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S02-12 [manual] | 机器人不在群内时打表情收不到事件，设置页提示可见 | EX-2.1 | 在真实飞书未加机器人的群打 📌，确认无反应；打开面板设置页看到提示 |
| ST-S02-13 [manual] | 真实飞书表情事件经 lark-cli 长连接到达中心 | Step 1→3 | 真实群打 📌，观察 center 日志出现事件并回帖 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件：AC-01、AC-02、AC-05 → ST-S02-01、ST-S02-02、ST-S02-03
- [x] Phase 1 异常验收条件：AC-03、AC-04 → ST-S02-05、ST-S02-06
- [x] EX：2.1（manual）、4.1、5.1、8.1、13.1、23.1、26.1 全部覆盖
- [x] API required：CandidatesArtifact.confidence、intake/dismiss 状态码 → UT-S02-13/14/15
- [x] DB UNIQUE/PK：feishu_events PK、source_items UNIQUE、candidates UNIQUE → UT-S02-05、UT-S02-08（间接）、UT-S02-12

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S02-AC-01 | 正常：群消息打表情入库，5 秒内回帖，分流卡出现，上下文含前后 20 条 | ST-S02-01, UT-S02-09, UT-S02-11 |
| S02-AC-02 | 正常：@机器人引用消息直接派活 | ST-S02-02, UT-S02-06 |
| S02-AC-03 | 异常：别人打的表情不入库不回复 | ST-S02-05, UT-S02-02 |
| S02-AC-04 | 异常：同一消息重复打表情回"已存在" | ST-S02-06, ST-S02-07 |
| S02-AC-05 | 异常：LLM 扫描候选只进面板，不推飞书不建任务 | ST-S02-03, ST-S02-04, UT-S02-14 |
