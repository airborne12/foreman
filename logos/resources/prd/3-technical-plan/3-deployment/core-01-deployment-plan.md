# core-01-deployment-plan

> 2026-10-01 执行器变更：以 `logos/changes/codex-only/proposal.md` 为准，所有定位、实现、review、调度与扫描会话仅使用 Codex。review 使用独立会话；Codex 满额时排队，启动失败用 Codex 新会话重试，旧执行器会话只能查看历史或开新会话。本文原有多执行器轮换、跨执行器 review 与 Claude 专用步骤由此替代。

> 最后更新：2026-09-10
> 模块：core（M1）
> 输入：`1-architecture/core-01-architecture-overview.md` 第六节交接表、`2-scenario-implementation/core-S05-runtime-onboarding.md`、`api/runtimes.yaml`（healthz）、`database/schema.sql`
> 本文只设计，不执行。部署执行须在代码实现完成、`openlogos verify` 通过并经你明确授权后进行。

## 一、部署目标

| 环境 | 用途 | 机器 | 说明 |
|------|------|------|------|
| `local` | 开发与自测 | 笔记本 | `pnpm dev` 起 center（含面板 HMR）与一个本机 worker；Postgres 用 docker 或本机 |
| `prod` | 唯一线上环境 | 中心机 172.17.2.13 + 开发机 10.26.20.3 + 笔记本（可选 runtime） | 单用户，无 staging，直接上生产；靠回滚策略与 smoke 兜底 |

**不设 staging 的理由**：单用户单实例，staging 只会让 Jira / 飞书这类外部副作用出现两份；用"发布目录切换 + 数据库备份 + smoke"替代预发。

**事实核对（2026-09-10）**：

| 项 | 中心机 | 开发机 | 笔记本 |
|----|--------|--------|--------|
| OS | macOS 26.6 | CentOS Stream 9 | macOS |
| Node | 25.7（brew，满足 ≥ 24） | 24.14（/mnt/disk6/common） | 24.19（nvm） |
| pnpm | 有 | 需确认 | 有 |
| Postgres | 17.9（brew，本机 5432，jiangkai2 为超级用户） | 不需要 | docker 或 brew |
| claude / codex / gh | 有 / 有 / 有 | 有 / 有 / 有（airborne12 已登录） | 有 / 坏 / 无 |
| lark-cli | **未安装**（部署前置） | 有（bot 身份） | 有（user 身份，需刷新） |
| 进程守护 | launchd（已有 hermes / openclaw 先例） | systemd --user，Linger=yes | launchd |
| 网络 | 出网经 sing-box 10809；可 ssh 到开发机 | 不能主动连中心；GitHub 直连 | 直连中心与开发机（VPN） |

## 二、部署拓扑

```mermaid
graph TB
    subgraph Center["中心机 172.17.2.13（macOS，用户 jiangkai2）"]
        LC[launchd ai.foreman.center]
        CEN[center 进程<br/>:7801 HTTP/WS/MCP + 面板静态]
        LW[launchd ai.foreman.worker]
        WKC[worker(center)]
        LT[launchd ai.foreman.tunnel.dev]
        TUN[ssh -R 7801:127.0.0.1:7801]
        PG[(Postgres 17.9<br/>db foreman)]
        LK[lark-cli 机器人身份<br/>event +subscribe 子进程]
        REL[~/foreman/releases/&lt;ts&gt;<br/>~/foreman/current → 软链]
    end
    subgraph Dev["开发机 10.26.20.3（CentOS 9，用户 jiangkai）"]
        SD[systemd --user foreman-worker.service]
        WKD[worker(dev)]
        WB[~/.foreman/bin/foreman-worker.mjs]
    end
    subgraph Laptop["笔记本（可选）"]
        LL[launchd ai.foreman.worker]
        WKL[worker(laptop)]
    end
    subgraph Ext["外部"]
        FA[飞书开放平台]
        JIRA[Jira Server（VPN）]
        GH[GitHub]
    end
    LC --> CEN
    LW --> WKC
    LT --> TUN
    CEN --> PG
    CEN --> LK
    LK <--> FA
    REL --> CEN
    TUN -.-> Dev
    SD --> WKD
    WB --> WKD
    WKD -->|ws://127.0.0.1:7801 经隧道| CEN
    WKD --> JIRA
    WKD --> GH
    WKC -->|ws://127.0.0.1:7801| CEN
    LL --> WKL
    WKL -->|ws://172.17.2.13:7801| CEN
```

- **一个端口**：中心只暴露 7801，面板、REST、`/ws/panel`、`/ws/worker`、`/mcp` 都在上面。监听 `0.0.0.0:7801`，依赖 VPN 网段可达性作为网络边界，不做公网暴露。
- **中心机也是 runtime**：跑一个本机 worker（transport `local`），承接文本类任务与候选扫描。
- **开发机只装 worker**：单文件 bundle 加配置，不需要仓库与 pnpm。
- **不引入 Docker、Redis、反向代理、域名、证书**：M1 不需要。

## 三、环境变量与密钥

### 3.1 中心机

| 项 | 位置 | 来源 | 入库 |
|----|------|------|------|
| `~/.foreman/center.yaml` | 配置文件（0600） | `foreman center init` 生成，模板见 core-03 3.2 | 否 |
| `FOREMAN_TOKEN` | macOS keychain `foreman-worker-token`，launchd plist 用 `security find-generic-password` 注入 | `center init` 随机生成 32 字节 | 否 |
| `FOREMAN_PANEL_TOKEN` | keychain `foreman-panel-token` | 同上 | 否 |
| `DATABASE_URL` | `center.yaml` | `postgres://foreman_app:<pw>@127.0.0.1:5432/foreman`，密码在 keychain | 否 |
| `HTTPS_PROXY` / `HTTP_PROXY` | launchd plist EnvironmentVariables | `http://127.0.0.1:10809`；`NO_PROXY=localhost,127.0.0.1,open.feishu.cn,open.larksuite.com,172.17.0.0/16,10.26.0.0/16` | 否 |
| 飞书应用 | lark-cli 自身配置（`lark-cli config init` + `auth login --as bot`） | 复用应用 `cli_a94d…` | 否 |
| `~/.jira.conf` | 不需要 | Jira 轮询在开发机执行 | — |

### 3.2 开发机

| 项 | 位置 | 来源 |
|----|------|------|
| `~/.foreman/worker.yaml` | 0600 | `foreman worker init` |
| `~/.foreman/env` | 0600，systemd `EnvironmentFile=` | `FOREMAN_TOKEN=…`（与中心相同） |
| `~/.jira.conf` | 已存在 | Jira PAT，jira-poll 作业读取 |
| gh 登录态 | 已存在 | `gh auth status` |
| Node 24 | `/mnt/disk6/common/node-v24.14.1-linux-x64/bin/node` | systemd 单元 `ExecStart` 用绝对路径 |

### 3.3 笔记本（可选 runtime）

同中心机 worker 的做法，`transport: direct`，`center.url: ws://172.17.2.13:7801`。

### 3.4 明确禁止

- 任何地方不得设置 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 供 agent 使用；agent 只用各 CLI 的订阅登录态。
- token 不写进仓库、不写进 plist 明文（用 keychain 或 EnvironmentFile）。
- 中心不保管 Jira PAT、gh token、飞书用户 token。

## 四、构建与发布命令

### 4.1 仓库与产物

```
foreman/
├── apps/center      → dist/center.mjs（esbuild 单文件）+ panel 静态资源
├── apps/panel       → apps/center/public/（Vite build 输出）
├── apps/worker      → dist/foreman-worker.mjs（esbuild 单文件，含 agent 适配器）
├── apps/cli         → dist/foreman.mjs（单文件）
├── packages/shared  → 类型与 zod schema，被三者内联
├── prisma/          → schema.prisma + migrations/
└── scripts/
    ├── build.sh
    ├── deploy-center.sh
    ├── deploy-worker.sh <runtime>
    ├── smoke.sh
    └── launchd/*.plist, systemd/foreman-worker.service
```

构建：

```bash
pnpm install --frozen-lockfile
pnpm -r build              # panel → center/public；center/worker/cli → dist/*.mjs
pnpm prisma generate
```

### 4.2 中心发布（在中心机执行，`scripts/deploy-center.sh`）

```bash
set -euo pipefail
TS=$(date +%Y%m%d%H%M%S)
REL=~/foreman/releases/$TS
git -C ~/foreman/repo fetch --tags && git -C ~/foreman/repo checkout "${1:-main}"
mkdir -p "$REL" && rsync -a ~/foreman/repo/ "$REL/" --exclude node_modules --exclude .git
cd "$REL" && pnpm install --frozen-lockfile --prod=false && pnpm -r build
# 迁移前备份（见第五节）
pg_dump -Fc -h 127.0.0.1 -U jiangkai2 foreman > ~/foreman/backups/foreman-$TS.dump
cd "$REL" && pnpm prisma migrate deploy
ln -sfn "$REL" ~/foreman/current
launchctl kickstart -k gui/$(id -u)/ai.foreman.center
launchctl kickstart -k gui/$(id -u)/ai.foreman.worker
~/foreman/current/scripts/smoke.sh prod && echo "DEPLOY_DONE $TS" >> ~/foreman/deploy.log
ls -dt ~/foreman/releases/* | tail -n +6 | xargs rm -rf   # 保留最近 5 个
```

launchd 单元 `~/Library/LaunchAgents/ai.foreman.center.plist`：`ProgramArguments = [/opt/homebrew/bin/node, ~/foreman/current/apps/center/dist/center.mjs]`，`WorkingDirectory = ~/foreman/current`，`KeepAlive = true`，`RunAtLoad = true`，`StandardOutPath/StandardErrorPath = ~/foreman/logs/center.{out,err}.log`，EnvironmentVariables 含代理与 `FOREMAN_HOME=~/.foreman`。token 由 center 启动时用 `security find-generic-password -s foreman-panel-token -w` 读取，不写在 plist。

隧道单元 `ai.foreman.tunnel.dev.plist`：`ProgramArguments = [~/foreman/current/apps/cli/dist/foreman.mjs, center, tunnel, dev, up, --foreground]`，`KeepAlive = true`。

### 4.3 worker 发布（在中心机执行，`scripts/deploy-worker.sh dev`）

```bash
set -euo pipefail
RT=$1
SRC=~/foreman/current/apps/worker/dist/foreman-worker.mjs
case "$RT" in
  dev)
    scp "$SRC" jiangkai@10.26.20.3:~/.foreman/bin/foreman-worker.mjs.new
    ssh jiangkai@10.26.20.3 'mv ~/.foreman/bin/foreman-worker.mjs ~/.foreman/bin/foreman-worker.mjs.prev 2>/dev/null; mv ~/.foreman/bin/foreman-worker.mjs.new ~/.foreman/bin/foreman-worker.mjs && systemctl --user restart foreman-worker && sleep 3 && systemctl --user is-active foreman-worker'
    ;;
  center)
    launchctl kickstart -k gui/$(id -u)/ai.foreman.worker ;;
  laptop)
    echo "在笔记本上执行 npm i -g @airborne12/foreman@<version> && foreman worker restart" ;;
esac
```

开发机 systemd 单元 `~/.config/systemd/user/foreman-worker.service`（模板 `scripts/systemd/foreman-worker.service`，`__HOME__` 由 `deploy-worker.sh` 渲染为 worker 家目录，当前为 `/mnt/disk14/jiangkai`）：

```
[Unit]
Description=foreman worker (dev)
After=network-online.target
[Service]
Environment=HOME=__HOME__
WorkingDirectory=__HOME__
EnvironmentFile=__HOME__/.foreman/env
ExecStart=/mnt/disk6/common/node-v24.14.1-linux-x64/bin/node __HOME__/.foreman/bin/foreman-worker.mjs
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
```

**worker 家目录写死，不用 `%h`**（2026-09-30 调整）：开发机账号 home 于 2026-09-29 从 `/mnt/disk1/jiangkai` 迁到 `/mnt/disk14/jiangkai`，而在跑的 systemd 用户实例仍带老 HOME、重登或重启后才换新 HOME。用 `%h` 时，worker 的配置、会话记录（`sessions.json`）、claude 工作区信任（`~/.claude.json`）、gh 凭据都会随 systemd 实例漂移。`deploy-worker.sh` 的做法：

- worker 家目录取单元里写死的 `HOME`（可用 `WORKER_HOME` 显式指定），其次 systemd 实例的 HOME，最后 ssh 的 `~`；bundle 与配置全部按绝对路径投递。
- 单元装进 systemd 当前实例读取的单元目录；若与 worker 家目录下的 `~/.config/systemd/user` 不同，在后者也放一份并建 `default.target.wants` 链接，机器重启后照样拉起。
- 发布后自检：systemd 实际执行的 bundle 必须与本次构建 md5 一致，否则报错。

迁移记录（2026-09-30）：worker 的 env、worker.yaml、sessions.json、bundle 从老 home 拷到新 home；agent 程序改用新 home 下同版本的 claude 2.1.284 / codex 0.158.0（订阅登录）；新 home 缺的 gh 凭据与 `.gitconfig` 从老 home 拷入（不覆盖已有）；老 home 原样保留作备份；9/29 误投递到新 home 的文件挪到 `~/.foreman.stray-<时间>`。

**版本兼容**：worker 注册时上报版本，中心按 `minWorkerVersion` 拒绝过旧 worker（S05 EX-10.1 的 `VERSION_UNSUPPORTED`）。发布顺序固定为**先中心后 worker**，中心必须兼容前一个 worker 版本。

### 4.4 首次部署的前置项（需要你人工完成）

1. 中心机安装 lark-cli 并以机器人身份登录：`lark-cli config init`（应用 `cli_a94d…`）→ `lark-cli auth login --as bot`。
2. 中心机建库：`createdb foreman && psql -d foreman -c "CREATE ROLE foreman_app LOGIN PASSWORD '<keychain>'"`，然后 `pnpm prisma migrate deploy`（schema.sql 的内容以 Prisma migration 形式提交，`foreman_app` 的 GRANT 在首个 migration 中）。
3. 中心机到开发机 ssh 免密（已具备）；开发机 `mkdir -p ~/.foreman/bin` 并执行 `foreman worker init`（首次由 scp 的 bundle 以 `node foreman-worker.mjs init` 运行）。
4. 生成两枚 token 存入 keychain（`foreman center init` 完成）；把 `FOREMAN_TOKEN` 写入开发机 `~/.foreman/env`。
5. 确认代理：中心机 `curl -x http://127.0.0.1:10809 https://api.anthropic.com/v1/messages` 返回 405。

## 五、数据迁移策略

| 项 | 做法 |
|----|------|
| 工具 | Prisma Migrate；`schema.sql` 作为设计源，首个 migration `0001_init` 与其等价 |
| 执行时机 | `deploy-center.sh` 中，备份之后、切换 `current` 之前 |
| 备份 | 每次发布前 `pg_dump -Fc` 到 `~/foreman/backups/`，保留 14 天；另有每日 03:00 launchd 定时备份 |
| 初始化数据 | `trust_counters` 13 行、`source_health` 3 行由 migration 写入；来源默认频道由 center 启动时幂等创建 |
| 兼容原则 | 只做加列、加表、加索引这类向前兼容迁移；改列名或删列分两次发布（先双写后清理） |
| 失败处理 | `migrate deploy` 失败则不切 `current`、不重启，旧版本继续运行；修复后重跑 |

## 六、回滚策略

| 触发 | 动作 | 耗时 |
|------|------|------|
| smoke 失败或启动后 5 分钟内 `healthz` 非 ok | `ln -sfn <上一个 release> ~/foreman/current && launchctl kickstart -k …center` | < 1 分钟 |
| 迁移引入的数据问题 | `pg_restore -c -d foreman ~/foreman/backups/foreman-<ts>.dump`，再回退 release；随后 `prisma migrate resolve --rolled-back <name>` | 数分钟，期间中心停机 |
| worker 版本问题 | 开发机：`mv foreman-worker.mjs.prev foreman-worker.mjs && systemctl --user restart foreman-worker`；中心 worker 随 release 一起回退 | < 1 分钟 |
| 隧道异常 | `foreman center tunnel dev down && up`；仍不通看 `~/foreman/logs/tunnel-dev.err.log` | 即时 |

回滚后必须再跑一次 `smoke.sh`，并在 `~/foreman/deploy.log` 记 `ROLLBACK <from> -> <to>`。

**不可回滚的副作用**：已发出的飞书消息、已写入的 Jira 评论、已创建的 PR。回滚只恢复平台状态，不撤销这些；因此发布窗口选在没有运行中会话时（面板状态视图运行中会话为 0，或 `foreman task list --state running` 为空）。

## 七、部署后检查清单

| # | 检查 | 命令 / 位置 | 通过标准 |
|---|------|-------------|---------|
| 1 | 中心健康 | `curl -s http://127.0.0.1:7801/healthz` | `status: ok`，`checks.database: ok`，`feishuSubscription: ok` |
| 2 | 进程守护 | `launchctl list \| grep ai.foreman` | center、worker、tunnel.dev 三项 PID 非空且 status 0 |
| 3 | 面板 | 浏览器打开 `http://172.17.2.13:7801/` | 登录后收件箱可见，顶部无红条 |
| 4 | 中心 worker | `foreman runtime list` | `center` 在线 |
| 5 | 隧道与开发机 worker | `foreman center tunnel dev status`；`foreman runtime list` | 隧道 up；`dev` 在线且标签含 `build:doris`、`vpn:jira` |
| 6 | 迁移 | `pnpm prisma migrate status` | 无 pending |
| 7 | 飞书 | `foreman center status` 的 feishu 段 | 事件订阅已连接；`lark-cli auth status --as bot` 有效 |
| 8 | 来源健康 | `curl …/api/system/sources` | jira 与 feishu 为 ok（jira 需在首次轮询后） |
| 9 | 日志 | `tail -n 50 ~/foreman/logs/center.err.log` | 无 error 级别行 |
| 10 | 备份 | `ls ~/foreman/backups/` | 本次发布的 dump 存在且 > 0 字节 |

## 八、冒烟测试方案

smoke 由 `scripts/smoke.sh <env>` 执行，结果按 OpenLogos reporter 格式写入 `logos/resources/verify/smoke-results.jsonl`，供 `openlogos smoke` 计算 Gate 3.8。所有检查只读或使用专用测试对象，**不触碰真实 Jira 单与真实飞书群**。具体 `SMOKE-*` 用例由 test-writer 写到 `logos/resources/test/smoke/core-smoke-test-cases.md`，本节是输入。

| 类别 | 检查项 | 预期 |
|------|--------|------|
| 健康检查 | `GET /healthz` | 200，database ok，scheduler ok |
| 配置与密钥 | center 能从 keychain 读到两枚 token；`DATABASE_URL` 可连；代理可达 Anthropic 与 OpenAI（HTTP 405 / 421） | 全部通过 |
| 数据库迁移 | `prisma migrate status` 无 pending；`trust_counters` 13 行；`source_health` 3 行 | 通过 |
| 静态资源 | `GET /` 返回面板 HTML，`GET /assets/*.js` 200 | 通过 |
| 认证 | 无 token 访问 `/api/inbox` 401；带 panelToken 200；错误 workerToken 的 `auth-check` 401 | 通过 |
| runtime 链路 | `GET /api/runtimes`：center 与 dev 在线，dev 标签含 `build:doris` 与 `vpn:jira` | 通过 |
| 隧道 | 中心机 `foreman center tunnel dev status` 为 up | 通过 |
| 核心链路（文本类） | `POST /api/tasks {source: "smoke: 写一句话", path: plan, kind: text}` → 任务路由到 center → 会话启动 → 60 秒内线程出现 ≥1 条 progress → 收件箱出现分流卡审批 → `POST /api/approvals/{key}/decide reject` → 任务 paused | 通过；该任务打 `smoke` 标记，24 小时后自动清理 |
| 核心链路（代码类，只读） | `POST /api/tasks {source: "smoke: 定位 be/src 中 NGramIndexReader", repo: selectdb/selectdb-core, path: plan}` → 路由到 dev → worktree 创建 → 代码定位会话 deliver → 分流卡含 ≥1 条 codeLocations → reject | 通过；验证开发机 worktree、构建环境软链、MCP 经隧道回写 |
| 飞书 | 中心以机器人身份向 owner 私聊发 `[smoke] <ts>`，`notifications` 表状态 sent；`lark-cli` 事件订阅进程存活 | 通过 |
| Jira（只读） | 派 `jira-lookup` 作业查一个固定存在的单（配置项 `smoke.jiraKey`），返回 found=true | 通过 |
| 面板推送 | 建 `/ws/panel` 连接，触发上面核心链路时 5 秒内收到 `inbox.new` | 通过 |
| 日志与监控 | `center.err.log` 无 error；`events` 表最近 5 分钟有记录 | 通过 |

`logos.config.json` 建议配置：

```json
"smoke": {
  "command": "bash scripts/smoke.sh prod",
  "result_path": "logos/resources/verify/smoke-results.jsonl",
  "report_path": "logos/resources/verify/smoke-report.md",
  "sandbox_mode": "off"
}
```

`sandbox_mode` 设 `off` 的原因：smoke 必须访问中心机上的 keychain、launchd 与真实网络，沙箱隔离会让检查失真；smoke.sh 只写 `result_path` 一个文件。

`verify.pre_run_command` 由 test-writer / code-implementor 阶段填写（建议 `pnpm test`，reporter 写 `logos/resources/verify/test-results.jsonl`）。

## 九、门禁结论

| 项 | 结论 |
|----|------|
| `deployment_required` | true |
| `smoke_required` | true |
| `environments` | `local`、`prod` |
| 人类确认点 | 首次部署前置项（第 4.4 节 5 项）；每次 `prod` 发布前确认无运行中会话；smoke 失败时的回滚决定 |
| 下一步 | Phase 3-4a：test-writer 设计 UT/ST 用例，并基于第八节产出 `logos/resources/test/smoke/core-smoke-test-cases.md` |
