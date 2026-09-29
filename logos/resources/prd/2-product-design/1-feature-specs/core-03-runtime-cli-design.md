# foreman 产品设计：runtime 接入与 CLI（M1）

> 最后更新：2026-09-09
> 模块：core
> 覆盖场景：S05（主）；S04 的斜杠命令兜底与 CLI 等价命令；S03 的 worktree 生命周期
> 配套原型：`2-page-design/core-03-runtime-cli-prototype-terminal.md`

## 一、产品类型与原型策略

本部分是 **CLI 工具**：一个 `foreman` 可执行文件，同时承担中心与 worker 两种角色，靠子命令区分。原型形式为终端交互模拟。

## 二、命令结构

```
foreman
├── center                      中心服务（只在中心机运行）
│   ├── init                    初始化：数据库连接、监听端口、预共享 token、飞书应用
│   ├── start [--foreground]    启动（默认注册为 launchd 常驻）
│   ├── status                  中心健康：DB、WebSocket、飞书订阅、来源轮询水位
│   └── tunnel <runtime> up|down|status   为不能外连的 runtime 建/拆 ssh -R 反向隧道
├── worker                      runtime 侧
│   ├── init                    交互式生成 ~/.foreman/worker.yaml（标签、仓库、构建环境、传输）
│   ├── start [--foreground]    启动并注册（默认注册为 launchd / systemd --user 常驻）
│   ├── status                  本机 worker：连接状态、会话数、worktree 数与磁盘
│   ├── doctor                  能力探测：claude / codex / gh / git / 仓库路径 / 代理
│   └── gc [--dry-run]          手动回收终态 worktree
├── runtime
│   ├── list                    所有 runtime 与标签、在线状态
│   └── show <name>
├── task                        与面板斜杠命令等价，供脚本与兜底使用
│   ├── new --source <ref> --repo <repo> --path fix|plan|proto [--runtime <n>] [--agent <a>]
│   ├── list [--state <s>]
│   ├── show <T-id>
│   ├── pause <T-id> / resume <T-id>
│   └── reply <T-id> "<text>"   向任务当前会话追加消息
├── approve <A-id> [--edit]     确认审批；--edit 打开 $EDITOR 修改正文（不计数）
├── reject <A-id> [--reason]
└── inbox                       终端版收件箱（只读列表）
```

**全局选项**：`--center <url>`（默认读 `~/.foreman/config.yaml`）、`--json`（机器可读输出）、`--quiet`。

## 三、配置文件

### 3.1 worker 配置 `~/.foreman/worker.yaml`

```yaml
name: dev                              # runtime 名，全局唯一
center:
  url: ws://127.0.0.1:7801             # 反向隧道时指向 localhost；直连时指向中心机
  token: ${FOREMAN_TOKEN}              # 预共享 token，建议放环境变量或 keychain
transport: reverse-tunnel              # direct | reverse-tunnel
labels:
  - agent:claude
  - agent:codex
  - build:doris
  - repo:apache/doris
  - repo:selectdb/selectdb-core
  - vpn:jira                           # 能访问 Jira
agents:
  claude: { bin: claude, max_concurrent: 3 }
  codex:  { bin: codex,  max_concurrent: 3 }
repos:
  apache/doris:
    main: /mnt/disk1/jiangkai/workspace/src/doris-clean
    worktree_root: /mnt/disk1/jiangkai/workspace/src/doris-worktrees
    push_remote: jk
  selectdb/selectdb-core:
    main: /mnt/disk1/jiangkai/workspace/src/selectdb-core
    worktree_root: /mnt/disk1/jiangkai/workspace/src/selectdb-core-worktrees
    push_remote: jk
build_env:                             # 按分支族的构建环境（原 pick-pr repos.md 内容迁入）
  apache/doris:
    branch-4.0: { thirdparty: /mnt/disk1/.../installed-arrow17, jdk: /mnt/disk6/common/jdk-17.0.16 }
    branch-4.1: { thirdparty: /mnt/disk1/.../installed-master,  jdk: /mnt/disk6/common/jdk-17.0.16 }
worktree:
  retain_days: 3
  disk_high_watermark: 0.85
heartbeat_seconds: 30
```

### 3.2 中心配置 `~/.foreman/center.yaml`

```yaml
listen: 0.0.0.0:7801
database: postgres://foreman@127.0.0.1:5432/foreman
token: ${FOREMAN_TOKEN}
proxy: http://127.0.0.1:10809           # 出网代理（飞书域名走 NO_PROXY）
feishu:
  app: cli_a94d…                        # 复用 lark-cli 应用，机器人身份
  owner_open_id: ou_…
  intake_emoji: PUSHPIN                 # 📌
  approve_emoji: DONE                   # ✅
  reject_emoji: CrossMark               # ❌
sources:
  jira:
    poll_seconds: 300
    jql: "assignee = currentUser() AND resolution = Unresolved"
    run_on_label: vpn:jira              # 轮询在带此标签的 runtime 上执行
    project_repo_map: { CIR: selectdb/selectdb-core, DORIS: apache/doris }
routing:
  code: { require: [build:doris], prefer: dev }
  analysis: { prefer: dev }
  text: { prefer: center }
trust:
  threshold: 5
  locked_manual: [merge_release, jira_done]
tunnels:
  dev: { ssh: jiangkai@10.26.20.3, remote_port: 7801 }
```

## 四、S05 交互规格：接入一台 runtime

拆分为 **S05.1 首次接入**、**S05.2 反向隧道**、**S05.3 路由与离线**。

### S05.1 首次接入（直连，笔记本）

**流程**：
1. 安装：`npm i -g @airborne12/foreman`（或 `curl | sh`）。
2. `foreman worker init`：交互式问答，自动探测 claude / codex / gh / git 与常见仓库路径，生成配置并打印。
3. `foreman worker doctor`：逐项检查，红项阻止启动。
4. `foreman worker start`：注册常驻服务并连接，输出注册结果与标签。
5. 面板 `/runtimes` 出现该 runtime。

#### 验收条件（交互级）

##### 正常：init 自动探测
- **GIVEN** 笔记本装有 claude 与 codex，无 doris 克隆
- **WHEN** 我运行 `foreman worker init`
- **THEN** 探测结果显示 `agent:claude ✓ agent:codex ✓ build:doris ✗`，问答默认 name 为主机名、transport 为 direct，完成后打印配置路径与"下一步：foreman worker doctor"

##### 正常：start 注册
- **GIVEN** doctor 全绿
- **WHEN** 我运行 `foreman worker start`
- **THEN** 输出"registered as laptop · labels: agent:claude, agent:codex · transport: direct"，退出码 0，`launchctl list` 含 `ai.foreman.worker`

##### 异常：token 错误
- **GIVEN** 配置了错误 token
- **WHEN** 我运行 `foreman worker start --foreground`
- **THEN** 输出红色"center rejected registration: invalid token"，退避 60 秒后重试并打印下次重试时间，退出码保持前台运行；`foreman worker status` 显示 `auth_failed`

### S05.2 反向隧道（开发机）

**流程**：
1. 中心机：`foreman center tunnel dev up` → 用 `center.yaml` 的 `tunnels.dev` 建立 `ssh -R 7801:127.0.0.1:7801 jiangkai@10.26.20.3`，以 autossh 语义常驻并纳入 launchd。
2. 开发机：`worker.yaml` 的 `center.url` 指向 `ws://127.0.0.1:7801`，`transport: reverse-tunnel`。
3. 开发机：`foreman worker start`。
4. 中心机：`foreman center tunnel dev status` 显示隧道存活与最近一次重连。

#### 验收条件（交互级）

##### 正常：隧道建立后注册
- **GIVEN** 中心机可 ssh 到开发机，隧道未建立
- **WHEN** 我在中心机运行 `foreman center tunnel dev up`，再在开发机运行 `foreman worker start`
- **THEN** 前者输出"tunnel dev: up (remote 127.0.0.1:7801 → center)"，后者输出"registered as dev · transport: reverse-tunnel"

##### 异常：隧道断开
- **GIVEN** 隧道存活，worker 在线
- **WHEN** ssh 连接被中断
- **THEN** 中心 30 秒内重建隧道（`tunnel status` 显示 reconnects +1），worker 端在 3 次心跳内重连成功，面板离线时间不超过 90 秒；若 5 分钟内无法重建，面板 dev 标红并推飞书

### S05.3 路由与离线

**路由规则**（中心执行）：
1. 任务类型 → `routing` 中的 `require` 标签必须全部命中，否则任务排队并注明缺失标签。
2. 命中多个 runtime 时取 `prefer`，其次取运行中会话数最少者。
3. 手动覆盖优先于以上规则。

#### 验收条件（交互级）

##### 正常：`runtime list` 输出
- **GIVEN** 三台 runtime 在线
- **WHEN** 我运行 `foreman runtime list`
- **THEN** 表格列出 name、state、transport、sessions（如 `2/6`）、disk、labels，离线行以 `offline` 标注

##### 正常：类型路由
- **GIVEN** 同上
- **WHEN** 我运行 `foreman task new --source CIR-20001 --repo selectdb/selectdb-core --path fix` 与 `foreman task new --source "调研 ngram 索引方案" --path plan --kind text`
- **THEN** `task show` 分别显示 `runtime: dev (routing: code → require build:doris)` 与 `runtime: center (routing: text → prefer center)`

##### 异常：心跳超时
- **GIVEN** dev worker 进程被 kill
- **WHEN** 90 秒后运行 `foreman runtime list`
- **THEN** dev 行 state 为 `offline (last heartbeat 1m32s ago)`，其上运行中的任务在 `task list` 里 state 为 `running (unreachable)`，不会被改派

## 五、S04 兜底与 S03 worktree 的 CLI 规格

### 5.1 斜杠命令与 CLI 等价表

| 面板斜杠命令 | CLI | 说明 |
|-------------|-----|------|
| `/task new --source <ref> --repo <r> --path <p>` | `foreman task new …` | 不经调度员直接产出草案 |
| `/task pause T-231` | `foreman task pause T-231` | |
| `/task resume T-231` | `foreman task resume T-231` | |
| `/approve A-88` | `foreman approve A-88` | |
| `/runtime` | `foreman runtime list` | |

### 5.2 worktree 生命周期（worker 执行）

- 创建：`<worktree_root>/<T-id>-<slug>`，从目标分支最新 `origin/<branch>` 建分支 `foreman/<T-id>`；按 `build_env` 写入构建环境（软链与 env 文件）；写入 `.foreman/context.md`（上下文包）与 `.foreman/task.json`。
- 复用：同一任务的重试与换 agent 复用同一 worktree。
- 回收：`retain_days` 后删除；磁盘超过 `disk_high_watermark` 时从最老终态 worktree 删起；运行中任务的 worktree 永不删除；每次删除写任务线程事件。
- `foreman worker gc --dry-run` 列出将删除项与释放空间。
- 会话记录落盘（2026-09-29）：worker 把自己起的会话（agent、会话 id、cwd、日志、MCP 地址与 token）写到 `~/.foreman/sessions.json`（0600，最多 200 条），重启后恢复：已结束的可继续续接，运行中的重新盯住（claude 轮询 `claude agents`，codex 轮询进程是否还在）。此前只在内存里，发布 worker 会让等审批 / 等回答的会话全部续接失败。
- claude 工作区信任（2026-09-29 起，经用户同意）：claude 2.1.284 起 `--bg` 只在被信任的目录里启动，git 仓库只认仓库根自己的信任、父目录的信任不继承，所以每个新 worktree 都要单独信任。worker 在起 claude（启动与续接）前，把该目录写进 `~/.claude.json`（设了 `CLAUDE_CONFIG_DIR` 则写那里）的 `projects.<路径>.hasTrustDialogAccepted=true`；启动仍报未信任时（正在运行的 claude 回写旧内容冲掉了条目）补标后重试一次；worktree 回收时删除对应条目。只处理 worker 自己管理的目录：各仓库 `worktreeRoot` 之下的子目录与文本会话目录 `~/.foreman/workspace`，其他路径一律不写。写入先读最新内容、写临时文件后改名替换；文件解析失败时不覆盖。

#### 验收条件（交互级）

##### 正常：gc 演练
- **GIVEN** 有 4 个终态超过 3 天的 worktree
- **WHEN** 我运行 `foreman worker gc --dry-run`
- **THEN** 列出 4 行（路径、任务、终态时间、大小）与合计释放空间，不删除任何文件

##### 异常：磁盘高水位
- **GIVEN** 磁盘 88%，有 2 个终态 1 天的 worktree 与 3 个运行中
- **WHEN** worker 定时回收触发
- **THEN** 只删除 2 个终态 worktree，运行中的保留，`worker status` 显示本次回收释放的空间与磁盘新水位
