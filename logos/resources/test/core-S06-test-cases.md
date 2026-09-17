# S06: 审批双通道与信任升级 — 测试用例

> 输入：`core-S06-approval-and-trust.md`（32 Step，8 EX）、`api/approvals.yaml`（decideApproval、revokeAction、listTrust、resetTrust、ActionType）、`api/mcp.yaml`（request_approval）、`database/schema.sql`（approvals、actions、trust_counters）、PRD S06 验收条件
> 测试隔离：fake lark-cli 回放 reaction 事件并记录回帖；动作执行器用可注入的 fake（Jira 评论 / 飞书回帖）

## 一、单元测试用例

### 1.1 审批创建与信任快照（来源：S06 Step 1–4；schema.sql → approvals、trust_counters 初始数据）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S06-01 | 创建审批记录 body_hash 与 trust 快照 | Step 4 | reply_review streak 2 manual | request(reply_review, body) | approvals.body_hash = sha256(body)；trust_mode_snapshot manual；trust_streak_snapshot 2；status pending |
| UT-S06-02 | 类型为 auto 时直接 auto_approved 并执行 | EX-4.1 | rerun_ci mode auto | request(rerun_ci) | status auto_approved；actions 1 行 auto=true revocable_until = now+7d；无 notifications |
| UT-S06-03 | locked 类型即使 streak ≥ 5 仍 pending | EX-19.1 | merge_release streak 10 | request(merge_release) | status pending，trust_mode_snapshot locked |
| UT-S06-04 | 初始 trust_counters 13 行，merge_release 与 jira_done 为 locked | schema.sql 初始数据 | 空库迁移 | 查询 | 13 行；两行 locked，其余 manual |
| UT-S06-05 | action_type 不在枚举被外键拒绝 | schema.sql → approvals.action_type FK | — | action_type "deploy" | 外键错误 |
| UT-S06-06 | expires_at = created + 30 分钟 | schema.sql → approvals.expires_at；跨场景约定 | — | 创建 | expires_at 差 30 分钟 |

### 1.2 双通道决定（来源：Step 11–18；EX-12.1、12.2、18.1、18.2）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S06-07 | ✅ 映射 approve，❌ 映射 reject，其他表情忽略 | Step 13 | pending 且 feishu_message_id = m1 | 三种 reaction | approved / rejected / 无变化 |
| UT-S06-08 | 非 owner reaction 忽略 | EX-12.1 | — | operator ≠ owner | 无变化；events approval.reaction_ignored |
| UT-S06-09 | 对 superseded 审批消息的 reaction 回帖"已作废" | EX-12.2 | 审批 superseded | ✅ | notifications reply 含"已作废"；状态不变 |
| UT-S06-10 | 对已 approved 审批再 ❌ 回帖"已于 hh:mm 确认" | EX-12.2 | approved | ❌ | reply 含"已于"；状态不变 |
| UT-S06-11 | 面板 decide 在飞书先到后返回 409 含 decidedVia | EX-18.1 | approved via feishu | POST decide | 409 APPROVAL_ALREADY_DECIDED，details.decidedVia=feishu |
| UT-S06-12 | bodyHash 不匹配返回 409 APPROVAL_BODY_CHANGED | EX-18.2 | body 已变 | POST decide 旧 hash | 409 APPROVAL_BODY_CHANGED |
| UT-S06-13 | 并发两通道同时决定只有一个成功 | Step 17 | pending | 并行 decide(panel) 与 decideByFeishu | 恰好一个成功，另一个 409 / 回帖忽略；approvals 只有一个 decided_via |

### 1.3 信任升降级（来源：Step 19；EX-19.1；Step 28–31）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S06-14 | 原样确认 streak +1 | Step 19 | streak 3 | approve 未改 | streak 4，last_confirmed_at 更新，total_confirmed +1 |
| UT-S06-15 | 第 5 次原样确认升级为 auto | Step 19 | streak 4 | approve | streak 5，mode auto，promoted_at 非空；events trust.changed change=promoted |
| UT-S06-16 | 否决清零并回 manual | Step 19 | streak 4 或 mode auto | reject | streak 0，mode manual，last_rejected_at 更新 |
| UT-S06-17 | 修改后确认不改 streak | Step 19 | streak 2 | approve editedBody | streak 2，approvals.modified true，final_body = editedBody |
| UT-S06-18 | 阈值可配（threshold 3） | trust_counters.threshold | threshold 3，streak 2 | approve | mode auto |
| UT-S06-19 | resetTrust 把 auto 重置为 manual 并清零 | approvals.yaml → resetTrust | mode auto | POST reset | manual，streak 0 |
| UT-S06-20 | resetTrust 对 locked 类型 409 | resetTrust 409 | merge_release | POST reset | 409 TRUST_LOCKED |
| UT-S06-21 | revoke 在 7 天内降级并清零 | Step 29–31 | auto 动作 3 天前 | POST revoke | trust manual streak 0；events trust.downgraded；actions.revoked_at 非空 |
| UT-S06-22 | revoke 超过 7 天 409 | ACTION_NOT_REVOCABLE | 动作 8 天前 | POST revoke | 409 |
| UT-S06-23 | listTrust 返回 13 个 counter、threshold 与 4 周趋势 | listTrust | 有历史审批 | GET /api/trust | counters 13；weeklyConfirmations 4 项；autoExecutions7d 正确 |

### 1.4 执行、作废与补偿（来源：Step 20–27、32；EX-20.1、EX-32.1）

| ID | 描述 | 来源 | 前置条件 | 输入 | 预期输出 |
|----|------|------|---------|------|---------|
| UT-S06-24 | 通过后唤醒等待中的 MCP request_approval | Step 20 | 挂起请求 | approve | MCP 返回 approved=true，finalBody = 最终正文 |
| UT-S06-25 | 通过后内部执行器失败 → approvals failed 且信任不回退 | EX-20.1 | fake Jira 评论 500 | approve(jira_comment) | approvals.status failed；actions failed；streak 已 +1 不回退；收件箱"重试"项 |
| UT-S06-26 | 正文变更作废旧审批并建新审批 | Step 25–27 | pending A-93 | supersede(newBody) | A-93 superseded 且 superseded_by = A-94；A-94 pending；notifications reply "已作废" + 新推送 |
| UT-S06-27 | 补偿可撤回动作成功 → actions reverted | Step 32 | fake 飞书回帖可撤回 | revoke | status reverted，compensation.status reverted |
| UT-S06-28 | 不可撤回动作 → not_revocable 且降级仍生效 | EX-32.1 | 动作为 create_pr | revoke | compensation not_revocable；trust 已降级；收件箱人工处理项 |
| UT-S06-29 | 审批 30 分钟过期 → MCP 返回 timeout，状态保持 pending | 跨场景约定；S03 EX-22.1 | 注入时钟 | 推进 30 分钟 | request_approval 返回 approved=false reason=timeout；approvals 仍 pending |
| UT-S06-33 | 需 agent 接手的动作否决且没有等待者时，否决理由与上下文进入任务所属频道并由调度员接手 | S06 Step 20 分支；真实使用 T-6 连撞三次 | create_pr 审批 pending，关联会话已 done（无 MCP 等待者） | decide reject 带 comment | 频道出现系统消息，含审批编号、任务与来源、否决理由原文；已有调度员则 session.resume 送入，否则拉起调度员会话 |
| UT-S06-34 | 批准但等待者已不在时同样承接，不静默丢弃 | S06 Step 20 分支 | 同上 | decide approve | 会话可续接则续接送入「已批准」；不可续接则同样进入频道由调度员接手 |
| UT-S06-36 | 中心执行器代跑的动作批准后不进频道 | S06 Step 20；approvals.execute 的 executor 口径 | jira_comment 审批 pending（executor=center） | decide approve | 频道不新增消息——执行结果由执行链路与失败卡承接，避免盖掉「回写失败」提示 |
| UT-S06-35 | 有等待者时保持原行为，不重复送进频道 | S06 Step 20 | 会话正阻塞在 request_approval | decide reject | MCP 返回 rejected；频道不新增系统消息，也不拉起调度员 |

## 二、场景测试用例

### 2.1 主路径

| ID | 描述 | 覆盖 Steps | 前置条件 | 操作序列 | 预期结果 |
|----|------|-----------|---------|---------|---------|
| ST-S06-01 | 飞书先批，面板同步，回帖含信任计数 | Step 1→24 | reply_review streak 2；fake lark-cli | 1 request_approval(reply_review) 2 回放 owner ✅ 3 GET /api/approvals/{key} 4 检查 fake lark-cli 记录 | 5 秒内 approval approved decided_via=feishu；events approval.decided 与 inbox.removed(reason decided_feishu)；回帖含"已确认（信任 3/5）"；动作执行且 actions succeeded |
| ST-S06-02 | 面板确认后飞书回帖"已在面板确认" | Step 14→24 | 同上 | 1 request 2 POST decide approve 3 检查回帖 | approved via panel；回帖含"已在面板确认"；streak +1 |
| ST-S06-03 | 五次原样确认后第六次自动执行 | Step 19 + EX-4.1 | rerun_ci streak 0 | 循环 5 次 request+approve → 第 6 次 request | 第 5 次后 mode auto、trust.updated promoted；第 6 次无 pending 审批、无飞书推送、actions auto=true；线程事件含"自动执行" |
| ST-S06-04 | 信任视图升级行高亮数据 | Step 22 | ST-S06-03 后 | GET /api/trust | rerun_ci mode auto streak 5，autoExecutions7d = 1 |

### 2.2 异常路径

| ID | 描述 | 覆盖 EX | 前置条件 | 触发条件 | 预期结果 |
|----|------|--------|---------|---------|---------|
| ST-S06-05 | 自动执行的动作事后否决并回滚 | EX-4.1 + Step 28→32 | rerun_ci auto，动作可撤回 | POST /api/actions/{id}/revoke | trust manual streak 0；actions reverted；events trust.downgraded；后续同类 request 重新 pending |
| ST-S06-06 | 非 owner 表情被忽略 | EX-12.1 | pending | 回放同事 ✅ | 无变化；events reaction_ignored |
| ST-S06-07 | 先 ✅ 后 ❌ 忽略后者并回帖 | EX-12.2 | pending | 回放 ✅ 再 ❌ | approved；第二次回帖含"已于…确认" |
| ST-S06-08 | 对作废消息的表情回帖引导 | EX-12.2 | 审批已 supersede | 回放旧消息 ✅ | 回帖"本条已作废"；新审批仍 pending |
| ST-S06-09 | 两通道竞争只有一个生效 | EX-18.1 | pending | 同时 decide 与 ✅ | 恰一个成功；面板 409 或飞书忽略回帖；events 只 1 条 approval.decided |
| ST-S06-10 | 正文变更后旧 hash 批准被拒，新审批可批 | EX-18.2 | pending，agent 变更正文 | decide 旧 hash → decide 新审批 | 409 APPROVAL_BODY_CHANGED；旧 superseded；新 approved |
| ST-S06-11 | 锁定类型十次确认仍人工 | EX-19.1 | merge_release | 10 次 request+approve → 第 11 次 | 第 11 次仍 pending；trust 视图 locked 无操作 |
| ST-S06-12 | 执行失败不回退信任并可重试 | EX-20.1 | fake Jira 评论先 500 后 200 | approve(jira_comment) → 重试 | 第一次 failed，收件箱重试项；重试后 succeeded；streak 只加一次 |
| ST-S06-13 | 不可补偿动作回滚 | EX-32.1 | create_pr auto 已执行 | revoke | 降级生效；compensation not_revocable；收件箱人工处理项 |
| ST-S06-14 | 修改后确认不计数 | Phase 1 AC-06 | streak 2 | decide approve editedBody | 动作按新正文执行；streak 仍 2 |

### 2.3 人工验证用例（[manual]）

| ID | 描述 | 覆盖 Steps | 验证方式 |
|----|------|-----------|---------|
| ST-S06-15 [manual] | 真实飞书上点 ✅ 5 秒内面板卡片变灰 | Step 11→22 | 手机点表情，观察面板 |
| ST-S06-16 [manual] | 信任视图升级时行高亮 1 秒 | Phase 2 S06.2 | 人工观察 |

## 三、覆盖度校验

- [x] Phase 1 正常验收条件 AC-01/02/03 → ST-S06-01、ST-S06-03、ST-S06-05
- [x] Phase 1 异常验收条件 AC-04/05/06 → ST-S06-11、ST-S06-10、ST-S06-14
- [x] EX：4.1、12.1、12.2、18.1、18.2、19.1、20.1、32.1 全部覆盖
- [x] API required：decideApproval.bodyHash → UT-S03-01（S03 已覆盖）；RequestApprovalInput.actionType/body → UT-S06-05（FK）与 mcp 校验
- [x] DB CHECK/FK：approvals.action_type FK、trust_counters 初始数据、status CHECK → UT-S06-04/05

## 四、验收条件追溯

| AC ID | 验收条件 | 覆盖用例 |
|-------|---------|---------|
| S06-AC-01 | 正常：飞书先批，5 秒内面板同步并显示"已在飞书批准"，动作执行 | ST-S06-01, UT-S06-11 |
| S06-AC-02 | 正常：连续 5 次原样确认后自动执行并标注 | ST-S06-03, UT-S06-15, UT-S06-02 |
| S06-AC-03 | 正常：否决并回滚使计数清零回人工 | ST-S06-05, UT-S06-16, UT-S06-21 |
| S06-AC-04 | 异常：锁定类型永不升级 | ST-S06-11, UT-S06-03, UT-S06-20 |
| S06-AC-05 | 异常：正文变更导致原审批作废并生成新审批 | ST-S06-10, UT-S06-12, UT-S06-26 |
| S06-AC-06 | 异常：修改后确认不计数 | ST-S06-14, UT-S06-17 |
