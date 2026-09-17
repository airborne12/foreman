# 实现任务

> 依据 proposal.md：需求级变更，需要部署，无数据迁移，不新增 smoke 用例。
> 待评审决策点 1–4 拍板后再开始产出 delta，避免方案反复。

## [delta] 规格变更

- [ ] 产出 delta 到 `deltas/prd/1-product-requirements/` — `core-01-requirements.md` §S06 主路径补齐否决之后的走向，并新增验收条件：否决且等待方不存在时，理由与上下文出现在频道且可继续对话；§S04 补充这一类对话触发来源
- [ ] 产出 delta 到 `deltas/prd/2-product-design/1-feature-specs/` — `core-04-conversation-design.md` 增加"审批否决"作为频道对话的触发来源，定义投入频道的消息构成
- [ ] 产出 delta 到 `deltas/prd/2-product-design/1-feature-specs/` — `core-02-panel-design.md` 定义收件箱条目消失时的去向提示与频道跳转
- [ ] 产出 delta 到 `deltas/prd/2-product-design/2-page-design/` — `core-04-conversation-prototype-dialogue.md` 增加否决后频道对话的样例
- [ ] 产出 delta 到 `deltas/prd/3-technical-plan/2-scenario-implementation/` — `core-S06-approval-and-trust.md` 在 Step 20 之后新增异常分支：等待方不存在时改由频道承接
- [ ] 产出 delta 到 `deltas/prd/3-technical-plan/2-scenario-implementation/` — `core-S04-channel-dispatch.md` 新增来自审批否决的对话入口
- [ ] 产出 delta 到 `deltas/prd/3-technical-plan/2-scenario-implementation/` — `core-S07-session-progress.md` 明确会话不可续接时降级为频道讨论而非静默失败
- [ ] 产出 delta 到 `deltas/api/` — `approvals.yaml` 的 `decideApproval` 响应体现讨论入口
- [ ] 产出 delta 到 `deltas/api/` — `channels.yaml` 说明频道消息可由审批否决产生
- [ ] 产出 delta 到 `deltas/test/` — `core-S06-test-cases.md` 新增用例：否决且无等待者、否决且会话可续接、批准且无等待者
- [ ] 产出 delta 到 `deltas/test/` — `core-S04-test-cases.md` 新增用例：审批否决触发频道对话、调度员不可用时的降级
- [ ] 产出 delta 到 `deltas/scenario/` — `core-S06-approval-and-trust.json` 增加对应编排步骤
- [ ] 产出 delta 到 `deltas/scenario/` — `core-S04-channel-dispatch.json` 增加对应编排步骤

## [code] 代码实现

- [ ] `apps/center/src/domain/approvals.ts` — `decide()` 在唤醒等待者失败（或无等待者）时进入新分支，交由频道承接
- [ ] `apps/center/src/domain/channels.ts` — 提供"由系统事件拉起/续接调度员会话"的入口，复用既有 `postMessage` 的拉起与续接逻辑
- [ ] `apps/center/src/domain/dispatch.ts` — 会话可续接时优先续接；不可续接时按决策点 2 流转任务状态并记录线程事件
- [ ] `apps/panel/src/views/Inbox.tsx` — 条目消失时提示讨论去向并可跳转频道
- [ ] `apps/panel/src/views/Channel.tsx` — 渲染来自审批否决的消息，可回跳任务线程
- [ ] `test/unit/S06.test.ts`、`test/unit/S04.test.ts` — 按新增用例编写单元测试
- [ ] `test/orchestration/` — 按新增编排步骤补齐

## [deploy] 部署执行

- [ ] 构建并发布中心（`scripts/build.sh` + `scripts/deploy-center.sh`）——仅中心与面板，worker 不重启，运行中的会话不受影响
