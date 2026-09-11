# 部署报告（core / prod）

> 生成时间：2026-09-11
> 执行人：人类授权后由 AI 按 `core-01-deployment-plan.md` 执行
> 依据：`logos/skills/deployment-executor/SKILL.md` Step 4–5

## 一、结论

| 项 | 结果 |
|----|------|
| 目标环境 | `prod`（中心机 172.17.2.13 + 开发机 10.26.20.3） |
| 发布版本 | release `20260911175917`（含面板），git `8c5bd63` + 面板与部署修正 |
| 中心服务 | ✅ 已上线，`/healthz` status ok |
| 中心机 runtime | ✅ `center` 在线（agent:claude / agent:codex / text） |
| 开发机 runtime | ✅ `dev` 在线（agent:claude / agent:codex / vpn:jira），经反向隧道接入 |
| 反向隧道 | ✅ `dev` up，reconnects 0 |
| 数据库迁移 | ✅ `0001_init` 已应用，trust_counters 13 行、source_health 3 行 |
| 面板 | ✅ 已上线（批次 5 交付），`GET /` 200 |
| 飞书通道 | ⏸️ 关闭（lark-cli 已装，未登录） |
| Jira 轮询 | ⏸️ 关闭（首次发布不自动拉真实单，需人工打开） |
| 冒烟测试 | 未运行，需你明确授权（见第六节） |

## 二、执行的命令

| 步骤 | 命令 | 影响 |
|------|------|------|
| 构建 | `bash scripts/build.sh` | 本地产出 center.mjs / foreman-worker.mjs / foreman.mjs 单文件 |
| 发布 | `bash scripts/deploy-center.sh` | 中心机建 `~/foreman/{releases,logs,backups}`、`~/.foreman/{env,center.yaml,worker.yaml}`、Postgres 库 `foreman`、两个 launchd 单元并启动 |
| worker | `bash scripts/deploy-worker.sh dev` | 开发机写 `~/.foreman/{env,worker.yaml,bin/foreman-worker.mjs}`、启用 `foreman-worker.service` |

迁移由中心启动时的 `Db.migrate()` 应用 `logos/resources/database/schema.sql`（本实现用 pg 直连 + SQL 迁移，不是方案里写的 Prisma Migrate）。

## 三、部署后检查清单（方案 §7）

| # | 检查 | 结果 |
|---|------|------|
| 1 | `/healthz` | ✅ status ok · database ok · scheduler ok · onlineRuntimes 2 |
| 2 | launchd 单元 | ✅ ai.foreman.center（pid 15489）、ai.foreman.worker（pid 15493）在跑 |
| 3 | 面板 | ✅ `GET /` 200，`<title>foreman</title>`，assets 正常，前端路由可深链 |
| 4 | 中心 worker | ✅ `center` 在线，6 个并发名额空闲 |
| 5 | 隧道与开发机 worker | ✅ 隧道 up；`dev` 在线，已登记 `repo:selectdb/selectdb-core`，仍缺 `build:doris` |
| 6 | 迁移 | ✅ 无 pending，初始数据齐 |
| 7 | 飞书 | ⏸️ `feishuSubscription: disabled` |
| 8 | 来源健康 | ⏸️ jira / feishu / github 均为 disabled（未启用） |
| 9 | 日志 | ✅ `center.err.log` 无 error |
| 10 | 备份 | ⏸️ 首次发布库为空，跳过 dump |

另外抽查：无 token 访问 `/api/inbox` 返回 401、带 panelToken 返回 200、错误 workerToken 的 `auth-check` 返回 401，收件箱返回空集。

## 四、回滚点

| 触发 | 动作 |
|------|------|
| 中心异常 | `ln -sfn ~/foreman/releases/<上一个> ~/foreman/current` 后 `launchctl kickstart -k gui/$(id -u)/ai.foreman.center`；本次是首次发布，没有上一个 release，回滚等于卸载 |
| 完全卸载 | `launchctl bootout gui/$(id -u)/ai.foreman.center`（worker 同理）→ `dropdb foreman` → `rm -rf ~/foreman ~/.foreman` |
| 开发机 worker | `mv ~/.foreman/bin/foreman-worker.mjs.prev ~/.foreman/bin/foreman-worker.mjs && systemctl --user restart foreman-worker` |
| 隧道 | `POST /api/system/tunnels/dev/down` 再 `/up`；日志见中心机 `~/foreman/logs/center.out.log` |

## 五、与部署方案的偏离

| 项 | 方案 | 实际 | 原因 |
|----|------|------|------|
| token 存放 | keychain | `~/.foreman/env`（0600） | 非交互 ssh 会话不能写 keychain（`User interaction is not allowed`）；方案 §3.4 允许 keychain 或 EnvironmentFile |
| 数据库账号 | `foreman_app` 带密码 | 以 OS 用户 `jiangkai2` 连本机库 | 迁移要建角色与 RLS 策略，需超级用户；单用户本机库、仅本机 Postgres |
| 迁移工具 | Prisma Migrate | `Db.migrate()` 应用 `schema.sql` | 批次 1 已把 Prisma 换成 pg 直连（见实现清单） |
| 发布来源 | 中心机 `git fetch` + `pnpm install` + `pnpm -r build` | 笔记本构建后 rsync 工作树 | foreman 仓库还没有远端；单文件 bundle 让中心机不需要 node_modules |
| 隧道保活 | 独立 launchd 单元 | 中心启动时由 TunnelManager 拉起并退避重连 | 与 `/api/system/tunnels` 状态接口一致，冒烟才查得到 |
| 中心机 lark-cli | 部署前置项 | 二进制已装到 `~/bin/lark-cli`，尚未登录 | app secret 不在 keychain，登录是交互式的，须你本人完成 |

## 六、未解决风险与下一步

1. **飞书通道关闭**：`~/bin/lark-cli` 已装好，`~/.lark-cli/config.json` 里已有应用 `cli_a94d111224385cb3`，但 app secret 不在 keychain（`keychain entry not found`）。需要你在中心机的交互式终端里补上 secret 并 `lark-cli auth login`，再把 `~/.foreman/center.yaml` 的 `feishu.enabled` 改 true、填 `owner_open_id` 与 `bot_open_id` 并重启中心。
2. **代码类任务还不会路由到 dev**：selectdb-core 已克隆到 `/mnt/disk15/jiangkai/selectdb-core`（分支 selectdb-cloud-4.0，2.0G），worktree 根目录 `/mnt/disk15/jiangkai/foreman-wt` 已建，`repo:selectdb/selectdb-core` 标签已加。还差 `build:doris`：`/mnt/disk6/common/doris-thirdparties/` 下有 2.1、3.0、3.1、master、automation-20260825 等 6 套预编译 thirdparty，选错会导致编译失败，需要你指定用哪一套，然后
   `ln -s /mnt/disk6/common/doris-thirdparties/<你选的>/installed /mnt/disk15/jiangkai/selectdb-core/thirdparty/installed`
   并在 `~/.foreman/worker.yaml` 的 labels 里加 `build:doris`、重启 `foreman-worker`。
3. **/mnt/disk15 已用 84%**：接近 worker 的 0.85 高水位，worktree 回收会比较频繁。
4. **Jira 轮询关闭**：确认无误后把 `sources.jira.enabled` 改 true 再重启中心，它会开始按 JQL 拉真实单并建任务。
5. **冒烟未跑**：`openlogos smoke` 需要你明确授权。现在跑的话，01–09 这几条应当通过（面板已上线），SMOKE-core-12（飞书）会失败、13（Jira）会跳过，10/11/15（会真实拉起 agent 会话）默认跳过，要跑需 `SMOKE_CORE_LINK=1`。
