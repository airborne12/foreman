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
| Jira 轮询 | ✅ 已开启（水位线设为开启时刻，不回补历史单） |
| 冒烟测试 | 已跑：通过 11 · 失败 2 · 跳过 3，Gate 3.8 FAIL（见第六节） |

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
2. ~~**代码类任务还不会路由到 dev**~~ **已解决（2026-09-15）**：thirdparty 选定 `doris-thirdparty-3.0`（selectdb-cloud-4.0 的 `vars.sh` 要求 arrow 17.0.0 / azure-core 1.16.0 / jindofs 6.8.2，与 3.0 一致；3.1 只多出 selectdb-core 未引用的 hadoop_hdfs_3_4 与 libevent_openssl；机器上另一份 selectdb-core 检出也用 3.0），已软链到主仓库 `thirdparty/installed`，worktree 通过 `custom_env.sh` 的 `DORIS_THIRDPARTY` 指向同一套。`~/.foreman/worker.yaml` 已加 `build:doris`、agent 改绝对路径（systemd 的 PATH 不含 `~/.local/bin`）。dev 上线后补跑了 T-1～T-6 六个排队的代码定位，六张分流卡都拿到真实代码位置（各 8 处）。过程中发现并修掉的问题见实现清单「批次 6」与「生产首轮代码定位暴露的问题」。
3. **/mnt/disk15 已用 84%**：接近 worker 的 0.85 高水位，worktree 回收会比较频繁。
4. **Jira 轮询已开启（2026-09-11 18:42）**：`sources.jira.enabled: true`，按 `assignee = currentUser() AND resolution = Unresolved` 每 5 分钟轮询一次，作业派到开发机执行。
   开启前用只读查询数过：符合该 JQL 的未解决单有 **112 个**。水位线原本为空，首轮会把这 112 个全部入库并各生成一张降级分流卡，还会排 112 个 code-locate 作业——等 dev 拿到 `build:doris` 上线时会一次性创建 112 个 worktree，而 `/mnt/disk15` 已用 84%。
   所以开启前把 `source_health.jira.watermark` 设成了当时的时间，**只收今后有更新的单，不回补历史**。要改成全量回补，在中心机执行：
   `psql -d foreman -c "UPDATE source_health SET watermark = NULL WHERE source='jira'"`，下一轮就会把 112 个单拉进来。

   开启后第一轮轮询暴露了一个实现 bug：`Intake.pollJira` 把水位线拼成 ISO 8601（`2026-09-11T10:42:07.619Z`），而 Jira 的 JQL 日期字面量只接受 `yyyy-MM-dd HH:mm` 这类格式，作业直接 400 失败。已修为按本地时区格式化（`jqlDate()`），UT-S01-01 原来断言的就是错误格式，一并改掉；全量 268 个用例通过后重新发布（release `20260911184927`）。这个 bug 单靠 M1 的测试发现不了：fake Jira 不校验 JQL 语法。
5. **冒烟结果（2026-09-11，开启 Jira 并修好 JQL 之后）**：通过 11、失败 2、跳过 3，Gate 3.8 FAIL。

| 用例 | 结果 | 说明 |
|------|------|------|
| 01 健康检查 / 02 launchd / 03 配置与密钥 / 04 代理 / 05 迁移 / 06 面板 / 07 认证 / 09 隧道 / 13 Jira / 14 来源健康 / 16 日志与备份 | ✅ | 13 查的是最近一次 jira-poll 作业成功（设计里的 `POST /api/system/smoke/jira-lookup` 未实现） |
| 08 runtime 链路 | ❌ | dev 在线但缺 `build:doris`（同第 2 条） |
| 12 飞书 | ❌ | lark-cli 已装未登录（同第 1 条） |
| 10 / 11 / 15 核心链路 | ⏭️ | 未自动化，见第 7 条 |

6. **设计缺口：基线分支是仓库级写死的，应当由分流卡给出**（2026-09-16 跑 T-6 时暴露）。`center.yaml` 的 `repo_base_branch` 只按仓库配一个值（`selectdb/selectdb-core` → `selectdb-cloud-4.0`），worktree 一律从它拉。但每个单要改的分支各不相同：T-6 的 search 降级代码在 `branch-selectdb-doris-4.1`，T-5 的 SNII 只在 `branch-hotfix-selectdb-cloud-4.1.7-minimax-rows`，T-1 是 cloud-26.1.3。结果是 agent 在 worktree 里根本找不到目标代码，只能自己去别的分支上看。分流卡已经能判断目标分支（T-5 的定位结论里就写了），缺的是把它作为 `baseBranch` 传给 `worktree.create`、并允许在拍板时覆盖。建议按 OpenLogos 走变更提案：`TriageArtifact` 增加 `targetBranch`，分流卡与 `decideApproval.overrides` 同步增加该字段。

8. **worker 的 systemd 环境没有代理，codex 一律 403**（2026-09-16 暴露）。开发机访问 `chatgpt.com` 必须走 `http://127.0.0.1:10809`，代理写在 `~/.bashrc` 里，只有交互式 shell 读得到；worker 由 `systemd --user` 拉起，不读 profile，于是 worker 派出去的 `codex exec` 连 `wss://chatgpt.com/backend-api/codex/responses` 直接 403 Forbidden，15 秒内失败。T-7（CORE-6140）、T-8（CIR-21828）的代码定位轮换到 codex，两次都因此失败并出降级卡（claude 名额当时被 T-6 占着）。claude 不受影响，说明其域名在该机可直连。
   已把 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 追加到 `~/.foreman/env`（worker 单元本来就有 `EnvironmentFile=%h/.foreman/env`），原文件备份为 `env.bak-20260916`；**要等正在跑的 T-6 结束后重启 worker 才生效**，重启会丢掉 worker 内存里的会话跟踪。待办：`deploy-worker.sh` 首次生成 env 时应一并写入代理，否则换机重装会再踩一次。

7. **设计缺口：`POST /api/tasks` 建的任务不会自动派发**。跑冒烟时核实：只有 Jira 入库、飞书入库、频道草案确认三条入口会调 `scheduleCodeLocate`；通过 REST（也就是 `foreman task new`）建的任务停在 `triaging`，不会起会话。所有场景文档（S01/S02/S04）都只描述了那三条入口，createTask 之后该做什么没有任何场景定义，所以这既是实现缺口也是设计缺口。M1 的 268 个用例都不覆盖这一点，全绿并不矛盾。建议按 OpenLogos 走一个变更提案补上，而不是在部署期临时改代码。核心链路冒烟（10/11/15）因此也没自动化。
