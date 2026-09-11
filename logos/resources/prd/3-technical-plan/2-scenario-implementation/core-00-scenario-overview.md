# 业务场景概览（技术实现）

> 最后更新：2026-09-09
> 模块：core
> M1 范围：S01–S07。S08–S12 属 M2/M3，本阶段不建模。

## 参与方约定（与架构图组件一致）

| 别名 | 组件 | 说明 |
|------|------|------|
| U | 用户 | 浏览器或飞书客户端里的姜凯 |
| P | 面板 SPA | Vite React，REST + WebSocket 订阅 |
| CLI | foreman CLI | REST 薄客户端 + 本机进程管理 |
| API | center HTTP | REST（`/api/*`）与 MCP（`/mcp`）同一进程同一端口 7801 |
| HUB | center WebSocket Hub | 面板订阅通道 `/ws/panel`，worker 通道 `/ws/worker` |
| CORE | center 领域核心 | 任务状态机、审批、信任、路由、事件总线 |
| SCH | center 调度器 | 定时 tick，派系统作业 |
| FS | center 飞书适配器 | lark-cli 子进程（机器人身份） |
| TUN | center 隧道管理 | ssh -R 子进程 |
| DB | Postgres 17 | 唯一状态存储 |
| WK | worker | 某台 runtime 上的 worker 守护进程（图中标注 dev / center） |
| AG | agent CLI | claude / codex / opencode 会话进程 |
| FA | 飞书开放平台 | 外部 |
| JIRA | Jira Server | 外部，仅 VPN |
| GH | GitHub | 外部，经 gh CLI |

## 场景地图

| 编号 | 场景名称 | Phase 1 | Phase 2 | Phase 3 时序图 | API | 编排 | 状态 |
|------|---------|---------|---------|--------------|-----|------|------|
| S01 | Jira 单自动入库并生成分流卡 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S02 | 飞书消息显式入库 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S03 | 拍板分流路径并一键启动 agent | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S04 | 在 IM 频道用口语派活 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S05 | 接入一台 runtime 并让任务路由到它 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S06 | 审批双通道与信任升级 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S07 | 跟踪会话进展并在线程中介入 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 时序图完成 |
| S08 | PR 的 CI 失败与 review 意见闭环 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | M2 |
| S09 | 指定分支 pick 与冲突处理 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | M2 |
| S10 | 合入与来源系统闭环 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | M2 |
| S11 | 每日摘要与飞书指令回流 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | M3 |
| S12 | 查看 runtime 与会话总览 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | M3 |

## 场景依赖关系

```
S05 runtime 接入 ──┬──▶ S01 Jira 入库（需要带 vpn:jira 的 runtime 跑轮询与带 build:doris 的 runtime 跑代码定位）
                  ├──▶ S02 飞书入库（代码定位同上）
                  └──▶ S04 口语派活（调度员会话跑在 center runtime）

S01 / S02 / S04 ──▶ 产生分流卡 ──▶ S03 拍板并启动
S03 ──▶ 会话运行 ──▶ S07 进展与介入
S03 / S07 中所有"需人确认的动作" ──▶ S06 审批与信任（横切场景，被 S01 的分流卡、S03 的创建 PR 与镜像回写、S07 的回复等复用）
```

- **S06 是横切场景**：它定义"审批对象"的生命周期，其他场景只在步骤中引用"生成审批 → 见 S06"，不重复画。
- **S01 与 S02 共享后半段**：从"上下文包组装完成"起两者一致，S02 的文档引用 S01 的 Step 11 起。
- **S05 是前置场景**：其他场景默认至少一个 runtime 在线；离线情形作为各场景的 EX 用例出现。

## 跨场景约定

- **幂等键**：worker 通道的每条指令带 `commandId`；同一 `commandId` 重放不重复执行。
- **事件先落库再广播**：CORE 的每个状态变更在同一事务内写 `events`，事务提交后由事件总线广播到 HUB。
- **审批先到先得**：`UPDATE approvals SET status=$1, decided_via=$2 WHERE id=$3 AND status='pending'`，影响行数为 0 即视为已被另一通道处理。
- **MCP 阻塞工具**：`ask_user` 与 `request_approval` 在 API 层挂起 HTTP 请求，最长 30 分钟；超时返回结构化"未回复"，不抛错。
- **错误码格式**：REST 错误统一 `{ code: "UPPER_SNAKE", message: "中文" }`；worker 通道错误 `{ type: "error", ref: commandId, code, message }`。

## 场景索引

| 编号 | Phase 1 | Phase 2 | Phase 3 |
|------|---------|---------|---------|
| S01 | `1-product-requirements/core-01-requirements.md#S01` | `2-product-design/1-feature-specs/core-02-panel-design.md#S01`、`core-04-conversation-design.md#S01` | `core-S01-jira-intake.md` |
| S02 | `…#S02` | `core-04-conversation-design.md#S02` | `core-S02-feishu-intake.md` |
| S03 | `…#S03` | `core-02-panel-design.md#S03`、`core-03-runtime-cli-design.md#5.2` | `core-S03-decide-and-dispatch.md` |
| S04 | `…#S04` | `core-02-panel-design.md#S04`、`core-04-conversation-design.md#S04` | `core-S04-channel-dispatch.md` |
| S05 | `…#S05` | `core-03-runtime-cli-design.md#S05` | `core-S05-runtime-onboarding.md` |
| S06 | `…#S06` | `core-02-panel-design.md#S06`、`core-04-conversation-design.md#S06` | `core-S06-approval-and-trust.md` |
| S07 | `…#S07` | `core-02-panel-design.md#S07`、`core-04-conversation-design.md#S07` | `core-S07-session-progress.md` |
