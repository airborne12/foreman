# foreman CLI 终端原型（S05，附 S03 worktree 与 S04 兜底）

> 配套规格：`1-feature-specs/core-03-runtime-cli-design.md`
> 以下为终端交互模拟，`$` 为用户输入。

## 1. 笔记本首次接入（S05.1，直连）

````
$ foreman worker init

foreman worker · 初始化

探测本机能力…
  claude   ✓ 2.1.260 (claude.ai 订阅)
  codex    ✗ 未找到可用二进制（/Users/jiangkai/.nvm/.../codex 缺 native 包）
  opencode ✓ 0.9.2
  gh       ✗ 未安装
  git      ✓ 2.47
  仓库     ✓ apache/doris → ~/Workspace/src/github.com/selectdb/apache-doris
           ✓ selectdb/selectdb-core → ~/Workspace/src/github.com/selectdb/selectdb-upstream
  构建环境 ✗ 未发现 thirdparty/installed（不会打 build:doris 标签）

? runtime 名称 (jiangkai-mbp) › laptop
? 中心地址 › ws://172.17.2.13:7801
? 传输方式 › direct
? 预共享 token › ****************（已写入 macOS keychain：foreman-token）
? 额外标签（逗号分隔，可空）› 

已生成 ~/.foreman/worker.yaml
  name: laptop
  transport: direct
  labels: agent:claude, agent:opencode, repo:apache/doris, repo:selectdb/selectdb-core

下一步：
  foreman worker doctor    检查能力
  foreman worker start     注册并常驻
````

````
$ foreman worker doctor

  中心连通   ✓ ws://172.17.2.13:7801 (12ms)
  token      ✓ 有效
  claude     ✓ 可执行；--bg 可用；已登录
  opencode   ✓
  codex      ⚠ 未标记 agent:codex（未找到可用二进制）
  仓库       ✓ 2 个；origin 可 fetch
  磁盘       ✓ 312G 可用（worktree_root: ~/Workspace/foreman-wt）
  代理       – 未配置（可直连）

0 error, 1 warning · 可以启动
````

````
$ foreman worker start

registered as laptop
  transport: direct
  labels:    agent:claude, agent:opencode, repo:apache/doris, repo:selectdb/selectdb-core
  agents:    claude 0/3, opencode 0/3
service:   launchd ai.foreman.worker (running)
````

## 2. 开发机通过反向隧道接入（S05.2）

中心机：

````
$ foreman center tunnel dev up

tunnel dev: connecting jiangkai@10.26.20.3 …
tunnel dev: up
  remote 127.0.0.1:7801 → center 127.0.0.1:7801
  supervisor: launchd ai.foreman.tunnel.dev (autossh, ServerAliveInterval 15)
````

开发机：

````
$ cat ~/.foreman/worker.yaml | head -6
name: dev
center:
  url: ws://127.0.0.1:7801
  token: ${FOREMAN_TOKEN}
transport: reverse-tunnel
labels: [agent:claude, agent:codex, build:doris, repo:apache/doris, repo:selectdb/selectdb-core, vpn:jira]

$ foreman worker start

registered as dev
  transport: reverse-tunnel (via 127.0.0.1:7801)
  labels:    agent:claude, agent:codex, build:doris, repo:apache/doris, repo:selectdb/selectdb-core, vpn:jira
  agents:    claude 0/3, codex 0/3
service:   systemd --user foreman-worker.service (active)
````

中心机，隧道断开又恢复后：

````
$ foreman center tunnel dev status

tunnel dev: up (since 09:41, reconnects: 1, last reconnect 10:22 after 18s down)
worker dev: online (last heartbeat 4s ago)
````

## 3. 路由与离线（S05.3）

````
$ foreman runtime list

NAME     STATE                         TRANSPORT        SESSIONS  DISK  LABELS
dev      online                        reverse-tunnel   2/6       71%   agent:claude agent:codex build:doris repo:apache/doris repo:selectdb/selectdb-core vpn:jira
center   online                        local            0/6       9%    agent:claude agent:codex text
laptop   offline (last heartbeat 3h)   direct           0/6       –     agent:claude agent:opencode repo:apache/doris repo:selectdb/selectdb-core
````

````
$ foreman task new --source CIR-20001 --repo selectdb/selectdb-core --path fix

T-231 created (triaging)
  source:  jira CIR-20001 · 查询超时回归
  repo:    selectdb/selectdb-core
  path:    fix
  routing: code → require build:doris → dev
  next:    分流卡就绪后进入收件箱
````

````
$ foreman task new --source "调研 ngram 索引在 LIKE 下推的可行性" --path plan --kind text

T-232 created (triaging)
  routing: text → prefer center → center
````

worker 被 kill 后 90 秒：

````
$ foreman runtime list

NAME     STATE                                TRANSPORT        SESSIONS  DISK  LABELS
dev      offline (last heartbeat 1m32s ago)   reverse-tunnel   2/6 (unreachable)  71%   …

$ foreman task list --state running

ID     STATE                   RUNTIME  AGENT  TITLE
T-231  running (unreachable)   dev      codex  CIR-20001 查询超时回归
T-228  running (unreachable)   dev      claude apache/doris#67657 review
````

token 错误：

````
$ foreman worker start --foreground

connecting ws://127.0.0.1:7801 …
error: center rejected registration: invalid token
retrying in 60s (attempt 1, backoff 60s → 120s → 300s max) · Ctrl+C 退出
````

## 4. worktree 回收（S03）

````
$ foreman worker gc --dry-run

候选（终态超过 3 天）：
  T-201-cir-19418-timeout     done 2026-09-04   4.1G   /mnt/disk1/.../selectdb-core-worktrees/T-201-cir-19418-timeout
  T-203-doris-67402-flaky     done 2026-09-05   3.8G   /mnt/disk1/.../doris-worktrees/T-203-doris-67402-flaky
  T-205-cir-19501-plan        done 2026-09-05   0.2G   …
  T-209-doris-67219-review    done 2026-09-06   3.9G   …
合计可释放 12.0G · 磁盘 71% → 66%
dry-run：未删除任何文件。去掉 --dry-run 执行。
````

磁盘高水位自动回收（worker 日志）：

````
10:31:02 gc: disk 88% > 85% high watermark
10:31:02 gc: removed T-214-… (done 1d, 4.0G)
10:31:04 gc: removed T-216-… (done 1d, 3.7G)
10:31:04 gc: skipped 3 running worktrees
10:31:04 gc: disk now 81% · freed 7.7G · events posted to T-214, T-216
````

## 5. 斜杠命令兜底与审批（S04 / S06）

````
$ foreman inbox

待拍板 (2)
  A-87  分流卡        T-231  CIR-20001 查询超时回归        dev·codex   2m
  A-89  分流卡        T-232  调研 ngram 索引…              center·claude 1m
审批 (1)
  A-88  回复 review   T-228.1 apache/doris#67657          信任 2/5    8m
需要输入 (0)

$ foreman approve A-87
A-87 confirmed (原样) · T-231 → queued · 分流卡确认 信任 1/5

$ foreman approve A-88 --edit
（打开 $EDITOR 编辑正文…保存退出）
A-88 confirmed (修改，不计数) · 执行中 · 信任 2/5

$ foreman reject A-89 --reason "先不做"
A-89 rejected · T-232 → paused
````
