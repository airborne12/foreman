# foreman 对话流程原型（S02 / S04 / S06 / S07 / S01 飞书推送）

> 配套规格：`1-feature-specs/core-04-conversation-design.md`
> 符号：👤 我；🤖 平台机器人（飞书，规则驱动）；🧭 调度员（IM 频道，agent 会话）；🛠 任务会话；⚙ 平台系统事件。

## 1. S02 飞书表情入库 → S01 待拍板推送

**飞书群「Doris 内核-索引」**

````
同事A 11:52
  客户那边 ngram 索引 LIKE 查询偶发超时，4.1.3 版本，日志我发你了 CIR-20001

👤 11:53  （给上面这条消息加 📌）

🤖 11:53  ↳ 回复
  已收录为 T-231 · 目标仓库 selectdb-core（猜测 0.82）· 面板 https://foreman.local/c/feishu/t/T-231
````

**飞书私聊「foreman」** 12:01

````
🤖
[待拍板] A-87 · 分流卡 · T-231 · CIR-20001 ngram 索引 LIKE 偶发超时
档位 简单修复 · 预估 小 · 仓库 selectdb-core（猜测）· runtime dev · agent codex
定位：be/src/olap/rowset/segment_v2/inverted_index_reader.cpp:412 timeout 未透传到 ngram 路径；
      be/src/olap/rowset/segment_v2/ngram_index_reader.cpp:88
建议：透传 timeout 并补一个 UT
✅ 按建议执行   ❌ 否决   面板修改：https://foreman.local/inbox#A-87

👤  （加 ✅）

🤖  ↳
A-87 已确认（分流卡确认 信任 1/5）· T-231 已排队到 dev · codex
````

## 2. S04 频道口语派活（面板 `#doris-index`）

````
👤 14:10
把 CIR-19418 修了，顺便 pick 到 branch-selectdb-doris-3.1

⚙ 14:10  调度员会话拉起中（claude）…

🧭 14:10  （工具调用：lookup_jira("CIR-19418") → 找到；lookup_pr 无）
🧭 14:10  （工具调用：propose_task({...})）

┌ 草案 ─────────────────────────────────────────────┐
│ 来源     CIR-19418 · FE 端 show index 语句报错       │
│ 仓库     selectdb/selectdb-core（Jira 项目映射）      │
│ 路径     简单修复                                    │
│ pick     branch-selectdb-doris-3.1   ⓘ M2 执行       │
│ runtime  dev（code → build:doris）                   │
│ agent    claude（轮换）                              │
│ [创建]  [修改]  [取消]                               │
└───────────────────────────────────────────────────┘

👤 14:11  [创建]

⚙ 14:11  T-233 已创建（triaging）→ 线程 T-233
````

**澄清分支**

````
👤 14:20
看看那个索引的问题

🧭 14:20  （工具调用：list_tasks({q:"索引", recent:5})）
🧭 14:20  （工具调用：ask_clarification）

  没找到明确的对象。你指的是哪一个？
  [T-231 CIR-20001 ngram LIKE 超时]  [T-233 CIR-19418 show index 报错]  [apache/doris#67538 gram index]  [都不是，我再说清楚]

👤 14:20  [T-231 CIR-20001 ngram LIKE 超时]

🧭 14:20
  T-231 正在 dev 上由 codex 处理（running，最近进展 3 分钟前）。要我做什么？
  [追加指令到 T-231]  [新建一个相关任务]
````

**多任务分支**

````
👤 14:30
CIR-19418 和 CIR-19420 都修一下

🧭 14:30  （lookup_jira ×2 → 都找到；propose_task ×2）
┌ 草案 1 · CIR-19418 … [创建][修改][取消] ┐  ┌ 草案 2 · CIR-19420 … [创建][修改][取消] ┐
````

**引用不存在**

````
👤 14:35
把 CIR-99999 修了

🧭 14:35  （lookup_jira("CIR-99999") → not found）
  没找到 CIR-99999。最近分配给你的是：
  [CIR-20001] [CIR-19418] [CIR-19420] [CIR-19377] [CIR-19350]  [都不是]
````

**调度员不可用**

````
👤 14:40
把 CIR-19420 修了

⚙ 14:40  调度员不可用（claude 与 codex 额度已耗尽，预计 15:20 恢复）。可用命令：
         /task new --source CIR-19420 --repo selectdb/selectdb-core --path fix

👤 14:40
/task new --source CIR-19420 --repo selectdb/selectdb-core --path fix

⚙ 14:40  ┌ 草案（命令直出）· CIR-19420 … [创建][修改][取消] ┐
````

## 3. S03 + S07 任务线程（面板 `#feishu` → T-231）

````
⚙ 11:53  来自飞书 · 群「Doris 内核-索引」· 前后 20 条对话已附加
⚙ 11:54  代码定位：dev · claude · 运行中
⚙ 12:01  分流卡就绪 → 收件箱 A-87
⚙ 12:03  已拍板（飞书 ✅，原样确认）· 路径 简单修复 · runtime dev · agent codex（轮换）
⚙ 12:03  会话已启动 dev · codex · 3f2a1c · worktree /mnt/disk1/…/T-231-cir-20001-ngram-timeout

🛠 12:06  复现成功：构造 200 万行 ngram 索引，LIKE '%abc%' 在 timeout=1s 时不返回。根因是
          NGramIndexReader::query 没有接收 RuntimeState 的 timeout。            [展开日志]

🛠 12:14  改动 2 个文件：透传 timeout 到 ngram 路径；新增 UT ngram_index_timeout_test。
          本地 UT 通过（3/3）。                                                  [展开日志]

🛠 12:15  ⚠ 需要你回答
          旧接口 NGramIndexReader::query(const std::string&) 还有一处调用在 FE 生成的
          兼容路径。方案一：保留旧接口做转发；方案二：直接删除并改调用方。选哪个？

（收件箱出现「需要输入」· 飞书私聊收到 [需要你回答]）

👤 12:20  方案二，删掉
⚙ 12:20  已送入会话 · 3f2a1c

🛠 12:31  已删除旧接口并改 1 处调用；全量 BE UT 相关目录通过。准备创建 PR。   [展开日志]

⚙ 12:31  审批 A-90 · 创建 PR · 信任 0/5 → 收件箱（飞书已推送）
👤 12:33  [确认]
⚙ 12:33  A-90 已确认（面板，原样）· 创建 PR 信任 1/5

🛠 12:34  ┌ 产物 ────────────────────────────────────────┐
          │ PR  selectdb/selectdb-core#6612               │
          │     [fix](index) pass timeout to ngram reader │
          │     +48 −9 · 3 files                          │
          │ 分支 foreman/T-231                            │
          └───────────────────────────────────────────────┘
⚙ 12:34  子任务 T-231.1 PR 已创建 · 状态 delivered
⚙ 12:34  子任务 T-231.2 review 已创建 · 由 claude 执行（作者 codex）
⚙ 12:35  审批 A-91 · 飞书回帖（镜像产物摘要到原消息）· 信任 0/5 → 收件箱
````

**失败分支**

````
🛠 12:14  ✗ 会话失败
          原因：BE 编译失败 · thirdparty/installed 软链缺失（branch-selectdb-doris-3.1 需要 doris-thirdparty-3.1）
          [查看日志]   [重试]  [换 agent]  [放弃]
👤 12:16  [重试]
⚙ 12:16  会话重启 dev · codex · 3f2a1c（复用 worktree，已按 build_env 修复软链）
````

**会话已停止后追加**

````
（13:40，会话空闲超过 1 小时，进程已被 supervisor 停止）
👤 13:41  顺便把 timeout 的默认值从 1s 改成 5s
⚙ 13:41  恢复会话 3f2a1c…
🛠 13:43  已改默认值并更新 UT；PR 追加 1 个 commit。                            [展开日志]
````

## 4. S06 飞书表情审批（私聊）

````
🤖 12:31
[审批] A-90 · 创建 PR · T-231 · selectdb/selectdb-core · 信任 0/5
> 标题：[fix](index) pass timeout to ngram reader
> base：selectdb-cloud-4.0   head：airborne12:foreman/T-231
> body：（模板已填，3 段，查看全文 https://foreman.local/inbox#A-90）
✅ 确认   ❌ 否决   修改后确认请到面板

👤  （加 ✅）
🤖  ↳ A-90 已确认（创建 PR 信任 1/5），正在执行
🤖  ↳ A-90 已完成：selectdb/selectdb-core#6612
````

**面板先处理**

````
🤖 12:35  [审批] A-91 · 飞书回帖 · T-231 …
（12:36 我在面板点了确认）
🤖 12:36  ↳ A-91 已在面板确认
👤  （12:37 又加了 ✅）
🤖  ↳ A-91 已于 12:36 在面板确认，本次操作忽略
````

**先 ✅ 后 ❌**

````
👤  （✅）
🤖  ↳ A-92 已确认（回复 review 信任 3/5），正在执行
👤  （❌）
🤖  ↳ A-92 已于 12:40 确认，如需撤销请到面板线程点「否决并回滚」
````

**正文变更作废**

````
🤖 12:50  [审批] A-93 · 回复 review 意见 · T-231.1 …
🤖 12:52  ↳ A-93 内容已变更，本条作废
🤖 12:52  [审批] A-94 · 回复 review 意见 · T-231.1 … （新正文）
````

**自动执行后的事后否决（面板线程）**

````
⚙ 15:02  自动执行 · 重跑 CI（TeamCity doris_be_ut）· 信任 5/5          [否决并回滚]
👤 15:10  [否决并回滚]
   ┌ 确认 ─────────────────────────────────────┐
   │ 将取消本次重跑，并把「重跑 CI」降级为人工确认 │
   │ [确认降级]  [取消]                          │
   └───────────────────────────────────────────┘
⚙ 15:10  已降级：重跑 CI → 人工（计数清零）· 本次重跑已取消
````

## 5. S07 飞书直接回复"需要你回答"

````
🤖 12:15
[需要你回答] T-231 · codex：
> 旧接口 NGramIndexReader::query(const std::string&) 还有一处调用…方案一保留转发，方案二直接删除。选哪个？
在面板线程回复，或直接回复本消息

👤 12:20  （飞书「回复」该消息）方案二，删掉
🤖  ↳ 已送入 T-231 的会话
````

**回复了不该回复的消息**

````
👤  （对 [待拍板] A-87 用文字回复）改成出方案
🤖  ↳ 该消息用 ✅/❌ 操作，修改请到面板：https://foreman.local/inbox#A-87
````

## 6. 推送合并（S01 补充）

````
🤖 16:00
你有 4 项待拍板（今日推送已达上限，改为整点汇总）：
  A-95 分流卡 T-240 · A-96 分流卡 T-241 · A-97 回复 review T-231.1 · A-98 分流卡 T-242
面板：https://foreman.local/inbox
````
