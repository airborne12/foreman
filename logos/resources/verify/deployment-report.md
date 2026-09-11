# 部署报告（core / prod）

> 生成时间：2026-09-11
> 执行人：人类授权后由 AI 按 `core-01-deployment-plan.md` 执行
> 依据：`logos/skills/deployment-executor/SKILL.md` Step 4–5

## 一、结论

| 项 | 结果 |
|----|------|
| 目标环境 | `prod`（中心机 172.17.2.13 + 开发机 10.26.20.3） |
| 发布版本 | release `20260911140932`，git `8c5bd63` |
| 中心服务 | ✅ 已上线，`/healthz` status ok |
| 中心机 runtime | ✅ `center` 在线（agent:claude / agent:codex / text） |
| 开发机 runtime | ✅ `dev` 在线（agent:claude / agent:codex / vpn:jira），经反向隧道接入 |
| 反向隧道 | ✅ `dev` up，reconnects 0 |
| 数据库迁移 | ✅ `0001_init` 已应用，trust_counters 13 行、source_health 3 行 |
| 面板 | ❌ 未交付（`GET /` 404），见「未解决风险」 |
| 飞书通道 | ⏸️ 关闭（中心机未安装 lark-cli） |
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
| 2 | launchd 单元 | ✅ ai.foreman.center（pid 95739）、ai.foreman.worker（pid 95816）在跑 |
| 3 | 面板 | ❌ `GET /` 404，面板 SPA 未实现 |
| 4 | 中心 worker | ✅ `center` 在线，6 个并发名额空闲 |
| 5 | 隧道与开发机 worker | ✅ 隧道 up；`dev` 在线，但标签缺 `build:doris` 与 `repo:*` |
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
| 中心机 lark-cli | 部署前置项 | 未安装，飞书关闭 | 需要交互式 `lark-cli auth login --as bot` |

## 六、未解决风险与下一步

1. **面板缺失**：`GET /` 返回 404。M1 的面板 SPA 未实现，目前只能用 CLI 与 REST 操作；冒烟 SMOKE-core-06 必定失败。
2. **飞书通道关闭**：需在中心机交互式执行 `lark-cli config init` 与 `lark-cli auth login --as bot`，然后把 `~/.foreman/center.yaml` 的 `feishu.enabled` 改 true、填 `owner_open_id` 与 `bot_open_id` 并重启中心。S02 与审批的飞书通道在此之前不可用。
3. **开发机没有 Doris 克隆**：`dev` 上没找到 selectdb-core 或 doris 工作副本，且家目录所在的 `/mnt/disk1` 只剩 42G。代码类任务会一直排队等 `build:doris`。需要你决定克隆位置（`/mnt/disk11` 3.0T 可用、`/mnt/disk13` 3.2T 可用），再在 `~/.foreman/worker.yaml` 里登记 `repos` 与 `labels`。
4. **Jira 轮询关闭**：确认无误后把 `sources.jira.enabled` 改 true 再重启中心，它会开始按 JQL 拉真实单并建任务。
5. **冒烟未跑**：`openlogos smoke` 需要你明确授权。现在跑的话，SMOKE-core-06（面板）会失败，SMOKE-core-12/13（飞书、Jira）会因为未启用而失败或跳过。建议先补上面板与 lark-cli 再跑完整冒烟。
