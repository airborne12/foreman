# 变更提案：reject-to-channel

> module: core | created: 2026-09-17

> **状态：已实现并上线（2026-09-17）**。lifecycle 仍为 initial，按用户要求直接实现，未走 delta/merge。范围扩展为「任务上下文的完整传递」：
> - worktree 基线分支与构建环境自适应 → `0b9e88b`
> - 否决/批准无等待者、会话失联 → 送进频道由调度员接手 → `db5c5d7`
> - 决策点落地：1=A（频道调度员）；2=按类型处理（定位出降级卡、实现类进失败卡）；3=A（不加字段，messages.payload.reason 标识）；4=同等处理，但仅限需 agent 接手的动作

## 变更原因

来自真实使用（2026-09-16/17，任务 T-6 / DORIS-29010）：

1. `create_pr` 审批 A-9 被否决，理由写在审批里（"推送目标应该是我自己的 fork"）。此时实现会话已经结束，`decide()` 找不到阻塞中的等待者，否决理由只写进了 messages 表的一条系统消息，**没有任何东西把它送回 agent**，任务僵死在 `waiting_approval` 不动。人工在 Claude Code 会话里追加消息触发续接才救回来。
2. A-11、A-12 连续重演。A-12 的否决理由是一次方向性调整——"不应该在 4.1 打补丁，而应该直接给 doris master 提 PR 把 `enable_common_expr_pushdown` 删掉"。这种理由恰恰需要人和 agent 往返讨论，而平台当时没有承接它的地方，讨论只能发生在平台之外。

根因不在实现，在需求：`core-01-requirements.md` §S06 主路径写的是「我在任一通道确认或否决 → 另一通道同步失效 → 动作执行」，**否决之后的走向从未定义**。S06 时序图 Step 20 只写了 `resolve(approvalId, approved|rejected, finalBody)` 唤醒等待方，等待方不存在时怎么办没有分支；S04 已有的「频道 + 调度员会话」人机对话机制也没有被接上。

用户要求的形态：**否决之后，平台应当带着否决理由和上下文在频道里拉起一次对话**，让人在平台内继续讨论下一步，而不是任务无声僵死、靠平台外的人工干预。

## 变更类型

需求级

## 变更范围

- 影响的需求文档：`prd/1-product-requirements/core-01-requirements.md` §S06（第 301 行起，主路径与验收条件）、§S04（第 224 行起，频道对话的适用范围）
- 影响的功能规格：`prd/2-product-design/1-feature-specs/core-04-conversation-design.md`（频道对话的触发来源）、`core-02-panel-design.md`（收件箱中被否决条目的去向、频道视图入口）
- 影响的原型：`prd/2-product-design/2-page-design/core-04-conversation-prototype-dialogue.md`、`core-02-panel-prototype.html`
- 影响的业务场景：`core-S06-approval-and-trust.md`（Step 19–20 之后新增异常分支）、`core-S04-channel-dispatch.md`（新增一类对话触发来源）、`core-S07-session-progress.md`（会话已终止时的续接与 fresh_session 降级）
- 影响的 API：`api/approvals.yaml` → `decideApproval`（响应需体现否决后产生的讨论入口）；`api/channels.yaml` → `postChannelMessage`（同一套频道消息与调度员拉起机制被复用）
- 影响的 DB 表：`messages`（复用既有 `channel_id` / `task_id` / `ref_type` / `ref_id`，无需改结构）、`sessions`（调度员会话已绑 `channel_id`，无需改结构）、`approvals`（是否需要记录"已就该否决拉起讨论"见待评审决策点 3）
- 影响的编排测试：`scenario/core-S06-approval-and-trust.json`、`scenario/core-S04-channel-dispatch.json`
- 影响的测试用例：`test/core-S06-test-cases.md`、`test/core-S04-test-cases.md`
- 影响的 smoke 测试：无（`test/smoke/core-smoke-test-cases.md` 不覆盖审批流；核心链路冒烟本就未自动化）

## 部署影响

- 是否需要部署：是
- 部署原因：改动在中心（审批决定后的分支逻辑、频道消息与调度员拉起）与面板，需要重新发布中心才能生效；worker 不涉及，不必重启，正在运行的会话不受影响
- 影响环境：生产（中心机 172.17.2.13）
- 是否涉及数据迁移：否（复用既有表与字段；若采纳待评审决策点 3 的方案 B 则需新增一列，届时再评估）
- 是否需要回滚预案：是（按既有方式切回上一个 release 软链并重启中心）
- 是否需要 smoke：否

## 变更概述

在审批被否决（以及批准但等待者已不存在）时，中心不再止步于"写一条系统消息"，而是把这次决定连同上下文投进任务所属频道，并按 S04 既有机制拉起或续接该频道的调度员会话，形成一个可以继续对话的入口。投进频道的内容至少包含：审批编号与动作类型、关联任务与来源单号、否决理由原文、被否决的正文摘要、以及该任务当前所处状态。

会话侧按"能续接则续接、不能则降级"处理：关联会话仍可续接时，把否决理由作为一次续接送回原会话；会话已终止或 worker 已重启导致无法续接时，不再静默失败，而是转由频道调度员承接讨论，并在任务线程留下明确指向频道的记录。任务状态不再停在无人推进的 `waiting_approval`，其去向见待评审决策点 2。

面板侧对应补充：收件箱中该条目消失时给出"讨论已移至频道 #<频道>"的去向提示；频道视图中这条消息可点击回到任务线程。

## 待评审决策点（需你拍板，评审后写入 delta）

1. **讨论落在哪里**：(A) 只在任务所属频道拉起调度员对话（你原话的方向，推荐）；(B) 只唤醒该任务自己的实现会话；(C) 两者都做——频道讨论 + 会话续接。推荐 A，理由是否决往往意味着方向要改，而调度员正是负责"派活与改派"的角色；实现会话的上下文绑在旧方向上，继续用它容易被既有结论带偏。
2. **任务状态去向**：(A) 保持 `waiting_approval`，等讨论产出结论后再流转；(B) 转 `paused`，由讨论结论显式恢复（推荐，语义更准确，也不会让收件箱一直挂着一个无人推进的任务）。
3. **是否记录讨论已拉起**：(A) 不加字段，用 `messages.ref_type='approval' + ref_id` 反查（推荐，无迁移）；(B) `approvals` 加一列指向讨论会话/消息（可追溯性更强，但需要迁移）。
4. **批准路径是否同等处理**：批准时若等待者也已不在（如审批超时后才批），是否同样走"频道承接"。推荐同等处理，否则同一个缺口会从否决换到批准再现一次。
