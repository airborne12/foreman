-- =====================================================================
-- foreman 数据库 Schema（PostgreSQL 17）
-- 来源：logos/resources/api/*.yaml（tasks / approvals / channels / runtimes /
--       worker-channel / mcp / panel-events），时序图 S01–S07
-- 生成：2026-09-09（Phase 3-2，M1 范围；M2/M3 字段以注释标注预留）
-- 约定：主键 UUID；时间 TIMESTAMPTZ；枚举用 TEXT + CHECK；JSONB 存结构化
--       payload；金额无；软删除仅 channels；API camelCase ↔ 列 snake_case
-- 单用户：应用层用 panelToken 鉴权；所有表启用 RLS，策略为 app 角色全量访问
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 序列：任务 key（T-231）与审批 key（A-88）的展示编号
-- ---------------------------------------------------------------------
CREATE SEQUENCE task_key_seq START 1;
CREATE SEQUENCE approval_key_seq START 1;

-- ---------------------------------------------------------------------
-- runtimes（来源：runtimes.yaml → listRuntimes/getRuntime；worker-channel.yaml → register/heartbeat；S05）
-- ---------------------------------------------------------------------
CREATE TABLE runtimes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  instance_id        UUID,
  online             BOOLEAN NOT NULL DEFAULT false,
  transport          TEXT NOT NULL CHECK (transport IN ('direct', 'reverse-tunnel', 'local')),
  labels             TEXT[] NOT NULL DEFAULT '{}',
  agents             JSONB NOT NULL DEFAULT '{}'::jsonb,
  repos              JSONB NOT NULL DEFAULT '{}'::jsonb,
  capabilities       TEXT[] NOT NULL DEFAULT '{}',
  worker_version     TEXT,
  disk_used_ratio    NUMERIC(5,4) CHECK (disk_used_ratio IS NULL OR (disk_used_ratio >= 0 AND disk_used_ratio <= 1)),
  disk_free_bytes    BIGINT,
  load               NUMERIC(8,2),
  tunnel_state       TEXT CHECK (tunnel_state IS NULL OR tunnel_state IN ('up', 'down', 'reconnecting')),
  tunnel_reconnects  INTEGER NOT NULL DEFAULT 0,
  tunnel_last_error  TEXT,
  last_seen_at       TIMESTAMPTZ,
  registered_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE runtimes IS '被 worker 管理的机器。S05 注册与心跳维护在线状态；路由按 labels 匹配';
COMMENT ON COLUMN runtimes.id IS '主键';
COMMENT ON COLUMN runtimes.name IS 'runtime 名，用户命名，全局唯一，如 dev / center / laptop';
COMMENT ON COLUMN runtimes.instance_id IS '当前连接的 worker 进程实例 id，用于区分重连与同名冲突（S05 EX-12.1）';
COMMENT ON COLUMN runtimes.online IS '是否在线；心跳超过 90 秒未到置 false（S05 Step 23）';
COMMENT ON COLUMN runtimes.transport IS 'direct 直连 / reverse-tunnel 经 ssh -R / local 中心机本机';
COMMENT ON COLUMN runtimes.labels IS '能力标签，如 agent:claude、build:doris、repo:apache/doris、vpn:jira';
COMMENT ON COLUMN runtimes.agents IS '各家 agent 配置 {claude: {bin, version, maxConcurrent}}';
COMMENT ON COLUMN runtimes.repos IS '仓库路径 {"apache/doris": {main, worktreeRoot, pushRemote}}';
COMMENT ON COLUMN runtimes.capabilities IS '可执行的系统作业种类：jira-poll、jira-lookup、gh、merge-tree、rg、git-publish（平台代做 git）';
COMMENT ON COLUMN runtimes.worker_version IS 'worker 版本';
COMMENT ON COLUMN runtimes.disk_used_ratio IS '磁盘使用率 0–1，来自心跳；≥0.85 触发高水位回收';
COMMENT ON COLUMN runtimes.disk_free_bytes IS '磁盘剩余字节';
COMMENT ON COLUMN runtimes.load IS '负载，来自心跳';
COMMENT ON COLUMN runtimes.tunnel_state IS '反向隧道状态，仅 transport=reverse-tunnel';
COMMENT ON COLUMN runtimes.tunnel_reconnects IS '隧道重连次数';
COMMENT ON COLUMN runtimes.tunnel_last_error IS '隧道最近错误';
COMMENT ON COLUMN runtimes.last_seen_at IS '最近心跳时间';
COMMENT ON COLUMN runtimes.registered_at IS '最近一次注册时间';
COMMENT ON COLUMN runtimes.created_at IS '创建时间';
COMMENT ON COLUMN runtimes.updated_at IS '更新时间，应用层刷新';

-- ---------------------------------------------------------------------
-- channels（来源：channels.yaml → listChannels/createChannel；S04）
-- ---------------------------------------------------------------------
CREATE TABLE channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 40),
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'source_default')),
  source_type   TEXT CHECK (source_type IS NULL OR source_type IN ('jira', 'feishu')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
COMMENT ON TABLE channels IS 'IM 频道。用户自建（kind=user），或来源默认频道（jira / feishu，首次入库自动创建）';
COMMENT ON COLUMN channels.id IS '主键';
COMMENT ON COLUMN channels.slug IS '频道标识，小写加连字符，作为 API 路径参数';
COMMENT ON COLUMN channels.title IS '显示名，可改';
COMMENT ON COLUMN channels.kind IS 'user 用户自建 / source_default 来源默认';
COMMENT ON COLUMN channels.source_type IS '来源默认频道对应的来源类型';
COMMENT ON COLUMN channels.created_at IS '创建时间';
COMMENT ON COLUMN channels.updated_at IS '更新时间';
COMMENT ON COLUMN channels.deleted_at IS '软删除时间；M1 无删除接口，预留';

-- ---------------------------------------------------------------------
-- tasks（来源：tasks.yaml → listTasks/createTask/getTask/pause/resume/retry；S01–S07）
-- 树结构：parent_id 指向根任务；key 形如 T-231 或 T-231.1
-- ---------------------------------------------------------------------
CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key              TEXT NOT NULL UNIQUE CHECK (key ~ '^T-[0-9]+(\.[0-9]+)?$'),
  parent_id        UUID REFERENCES tasks(id) ON DELETE CASCADE,
  channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  title            TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'triaging' CHECK (state IN (
                     'draft', 'triaging', 'pending_decision', 'queued', 'running',
                     'waiting_input', 'waiting_approval', 'failed', 'delivered', 'done', 'paused')),
  state_before_pause TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('code', 'analysis', 'text', 'review', 'pr', 'branch')),
  path             TEXT CHECK (path IS NULL OR path IN ('fix', 'plan', 'proto')),
  source_type      TEXT NOT NULL CHECK (source_type IN ('jira', 'feishu', 'channel', 'cli', 'github')),
  source_ref       TEXT NOT NULL,
  source_url       TEXT,
  repo_name        TEXT,
  repo_source      TEXT NOT NULL DEFAULT 'unresolved' CHECK (repo_source IN ('mapping', 'llm', 'manual', 'unresolved')),
  repo_confidence  NUMERIC(4,3) CHECK (repo_confidence IS NULL OR (repo_confidence >= 0 AND repo_confidence <= 1)),
  repo_candidates  TEXT[] NOT NULL DEFAULT '{}',
  runtime_name     TEXT,
  agent            TEXT CHECK (agent IS NULL OR agent IN ('claude', 'codex', 'opencode')),
  author_agent     TEXT CHECK (author_agent IS NULL OR author_agent IN ('claude', 'codex', 'opencode')),
  pick_targets     TEXT[] NOT NULL DEFAULT '{}',
  queue_reason     TEXT,
  decision         JSONB,
  failure_reason   TEXT,
  pr_url           TEXT,
  branch_name      TEXT,
  terminal_at      TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE tasks IS '任务树。根任务对应一条需求；子任务对应 PR / 分支 / review；状态机见 core-02-panel-design 2.5';
COMMENT ON COLUMN tasks.id IS '主键';
COMMENT ON COLUMN tasks.key IS '公开 key：根任务 T-<seq>，子任务 T-<seq>.<n>';
COMMENT ON COLUMN tasks.parent_id IS '父任务；根任务为 NULL';
COMMENT ON COLUMN tasks.channel_id IS '所属频道，线程挂在频道下';
COMMENT ON COLUMN tasks.title IS '标题，来自需求 summary 或用户输入';
COMMENT ON COLUMN tasks.state IS '任务状态';
COMMENT ON COLUMN tasks.state_before_pause IS '暂停前的状态，resume 时恢复';
COMMENT ON COLUMN tasks.kind IS '任务类型，决定路由：code / analysis / text / review / pr / branch';
COMMENT ON COLUMN tasks.path IS '分流档位：fix 简单修复 / plan 出方案 / proto 出原型';
COMMENT ON COLUMN tasks.source_type IS '需求来源类型';
COMMENT ON COLUMN tasks.source_ref IS '来源引用：Jira key / 飞书 messageId / 频道消息 id / CLI 文本';
COMMENT ON COLUMN tasks.source_url IS '来源链接';
COMMENT ON COLUMN tasks.repo_name IS '目标仓库 owner/name；待确认时为 NULL';
COMMENT ON COLUMN tasks.repo_source IS '仓库来源：mapping 映射 / llm 猜测 / manual 手动 / unresolved 待确认';
COMMENT ON COLUMN tasks.repo_confidence IS 'LLM 猜测置信度 0–1；<0.6 视为待确认';
COMMENT ON COLUMN tasks.repo_candidates IS 'LLM 给出的候选仓库';
COMMENT ON COLUMN tasks.runtime_name IS '最终路由到的 runtime';
COMMENT ON COLUMN tasks.agent IS '执行本任务的 agent';
COMMENT ON COLUMN tasks.author_agent IS '实现阶段的作者 agent，review 子任务必须用另一家';
COMMENT ON COLUMN tasks.pick_targets IS 'pick 目标分支；M1 只记录不执行';
COMMENT ON COLUMN tasks.queue_reason IS '排队原因，如 waiting runtime dev / codex 队列第 2 位';
COMMENT ON COLUMN tasks.decision IS '拍板结果 {path, repo, runtime, agent, modified, decidedVia, decidedAt}';
COMMENT ON COLUMN tasks.failure_reason IS '失败原因摘要';
COMMENT ON COLUMN tasks.pr_url IS 'PR 子任务的链接';
COMMENT ON COLUMN tasks.branch_name IS '工作分支名 foreman/<key>';
COMMENT ON COLUMN tasks.terminal_at IS '到达终态（done/paused 放弃）的时间，worktree 回收依据';
COMMENT ON COLUMN tasks.last_activity_at IS '最近活动时间，频道线程排序依据';
COMMENT ON COLUMN tasks.created_at IS '创建时间';
COMMENT ON COLUMN tasks.updated_at IS '更新时间';

-- ---------------------------------------------------------------------
-- source_items（来源：S01 Step 10、S02 Step 5 去重）
-- ---------------------------------------------------------------------
CREATE TABLE source_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   TEXT NOT NULL CHECK (source_type IN ('jira', 'feishu', 'github')),
  external_id   TEXT NOT NULL,
  task_id       UUID REFERENCES tasks(id) ON DELETE SET NULL,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_updated_at TIMESTAMPTZ,
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, external_id)
);
COMMENT ON TABLE source_items IS '来源系统对象的去重登记：Jira issue、飞书消息、GitHub PR。同一外部对象只对应一个任务';
COMMENT ON COLUMN source_items.id IS '主键';
COMMENT ON COLUMN source_items.source_type IS '来源类型';
COMMENT ON COLUMN source_items.external_id IS '外部标识：Jira key / 飞书 message_id / owner/repo#n';
COMMENT ON COLUMN source_items.task_id IS '对应任务';
COMMENT ON COLUMN source_items.raw IS '最近一次拉取的原始对象';
COMMENT ON COLUMN source_items.external_updated_at IS '外部对象的 updated 时间，Jira 轮询水位线取此列最大值';
COMMENT ON COLUMN source_items.seen_at IS '最近看到时间';
COMMENT ON COLUMN source_items.created_at IS '首次登记时间';

-- ---------------------------------------------------------------------
-- context_packs（来源：tasks.yaml ContextPack；mcp.yaml get_task；S01 Step 11）
-- ---------------------------------------------------------------------
CREATE TABLE context_packs (
  task_id        UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL DEFAULT '',
  source_text    TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]'::jsonb,
  jira           JSONB,
  code_locations JSONB NOT NULL DEFAULT '[]'::jsonb,
  plan_doc       TEXT,
  partial        BOOLEAN NOT NULL DEFAULT false,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE context_packs IS '任务的上下文包，agent 起手读取；一任务一条，可随代码定位补齐而更新';
COMMENT ON COLUMN context_packs.task_id IS '任务，同时是主键';
COMMENT ON COLUMN context_packs.summary IS '一句话摘要';
COMMENT ON COLUMN context_packs.source_text IS '需求原文';
COMMENT ON COLUMN context_packs.conversation IS '来源对话前后文 [{sender, text, at}]';
COMMENT ON COLUMN context_packs.jira IS 'Jira 字段 {key, project, component, version, priority, commentsSummary, attachments}';
COMMENT ON COLUMN context_packs.code_locations IS '代码定位 [{file, line, symbol, why}]，最多 8 条';
COMMENT ON COLUMN context_packs.plan_doc IS '按方案实现时附加的方案全文';
COMMENT ON COLUMN context_packs.partial IS '上下文读取失败的降级标记（S02 EX-8.1）';
COMMENT ON COLUMN context_packs.version IS '版本号，每次更新加一，写入 .foreman/context.md 时带上';
COMMENT ON COLUMN context_packs.created_at IS '创建时间';
COMMENT ON COLUMN context_packs.updated_at IS '更新时间';

-- ---------------------------------------------------------------------
-- triage_cards（来源：tasks.yaml TriageCard；mcp.yaml TriageArtifact；S01 Step 24）
-- ---------------------------------------------------------------------
CREATE TABLE triage_cards (
  task_id          UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  tier             TEXT NOT NULL CHECK (tier IN ('fix', 'plan', 'proto')),
  effort           TEXT NOT NULL CHECK (effort IN ('small', 'medium', 'large')),
  repo_name        TEXT,
  repo_confidence  NUMERIC(4,3),
  repo_candidates  TEXT[] NOT NULL DEFAULT '{}',
  suggested_path   TEXT NOT NULL,
  code_locations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_runtime  TEXT,
  default_agent    TEXT CHECK (default_agent IS NULL OR default_agent IN ('claude', 'codex', 'opencode')),
  degraded         BOOLEAN NOT NULL DEFAULT false,
  degraded_reason  TEXT,
  approval_id      UUID,
  session_id       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE triage_cards IS '分流卡：代码定位会话对新任务的第一份产出，等待用户拍板';
COMMENT ON COLUMN triage_cards.task_id IS '任务，同时是主键';
COMMENT ON COLUMN triage_cards.tier IS '建议档位';
COMMENT ON COLUMN triage_cards.effort IS '工作量预估';
COMMENT ON COLUMN triage_cards.repo_name IS 'agent 判断的目标仓库';
COMMENT ON COLUMN triage_cards.repo_confidence IS '仓库置信度';
COMMENT ON COLUMN triage_cards.repo_candidates IS '仓库候选';
COMMENT ON COLUMN triage_cards.suggested_path IS '建议路径，一句话';
COMMENT ON COLUMN triage_cards.code_locations IS '代码定位 [{file, line}]';
COMMENT ON COLUMN triage_cards.default_runtime IS '按路由规则的默认 runtime';
COMMENT ON COLUMN triage_cards.default_agent IS '按轮换的默认 agent';
COMMENT ON COLUMN triage_cards.degraded IS '降级卡（开发机离线或定位失败）';
COMMENT ON COLUMN triage_cards.degraded_reason IS '降级原因';
COMMENT ON COLUMN triage_cards.approval_id IS '对应的 triage_confirm 审批（外键在 approvals 建表后添加）';
COMMENT ON COLUMN triage_cards.session_id IS '产出本卡的代码定位会话';
COMMENT ON COLUMN triage_cards.created_at IS '创建时间';
COMMENT ON COLUMN triage_cards.updated_at IS '更新时间；降级卡补齐时原位更新';

-- ---------------------------------------------------------------------
-- sessions（来源：tasks.yaml Session；worker-channel.yaml session.*；S03、S07）
-- ---------------------------------------------------------------------
CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID REFERENCES tasks(id) ON DELETE CASCADE,
  channel_id        UUID REFERENCES channels(id) ON DELETE CASCADE,
  runtime_id        UUID NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  agent             TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'opencode')),
  model             TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('implement', 'review', 'code_locate', 'plan', 'proto', 'dispatcher', 'candidate_scan')),
  state             TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'running', 'waiting_input', 'done', 'failed', 'stopped', 'lost')),
  reachable         BOOLEAN NOT NULL DEFAULT true,
  agent_session_id  TEXT,
  worktree_id       UUID,
  cwd               TEXT,
  prompt            TEXT NOT NULL,
  mcp_token_hash    TEXT,
  mcp_token_expires_at TIMESTAMPTZ,
  pid               INTEGER,
  exit_code         INTEGER,
  failure_reason    TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  last_progress_at  TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (task_id IS NOT NULL OR channel_id IS NOT NULL OR kind = 'candidate_scan')
);
COMMENT ON TABLE sessions IS 'agent 会话。任务会话绑定 task_id；调度员会话绑定 channel_id；候选扫描两者皆空。并发闸门按 (runtime_id, agent, state in planned/running) 计数';
COMMENT ON COLUMN sessions.id IS '主键，即 worker 通道的 sessionId';
COMMENT ON COLUMN sessions.task_id IS '所属任务';
COMMENT ON COLUMN sessions.channel_id IS '调度员会话所属频道';
COMMENT ON COLUMN sessions.runtime_id IS '所在 runtime';
COMMENT ON COLUMN sessions.agent IS 'agent 家';
COMMENT ON COLUMN sessions.model IS '模型别名';
COMMENT ON COLUMN sessions.kind IS '会话种类';
COMMENT ON COLUMN sessions.state IS '会话状态；planned 为预占名额';
COMMENT ON COLUMN sessions.reachable IS 'runtime 失联时为 false，重连对账后恢复';
COMMENT ON COLUMN sessions.agent_session_id IS 'claude --bg 或 codex 的会话 id，用于 resume / logs / stop';
COMMENT ON COLUMN sessions.worktree_id IS '使用的 worktree（外键在 worktrees 建表后添加）';
COMMENT ON COLUMN sessions.cwd IS '工作目录';
COMMENT ON COLUMN sessions.prompt IS '启动提示词全文';
COMMENT ON COLUMN sessions.mcp_token_hash IS '任务级 MCP token 的 sha256，明文不入库';
COMMENT ON COLUMN sessions.mcp_token_expires_at IS 'MCP token 失效时间，任务终态即失效';
COMMENT ON COLUMN sessions.pid IS 'worker 报告的进程 id';
COMMENT ON COLUMN sessions.exit_code IS '进程退出码';
COMMENT ON COLUMN sessions.failure_reason IS '失败原因摘要';
COMMENT ON COLUMN sessions.attempt IS '同一任务的第几次尝试（重试 / 换家递增）';
COMMENT ON COLUMN sessions.started_at IS '启动时间';
COMMENT ON COLUMN sessions.ended_at IS '结束时间';
COMMENT ON COLUMN sessions.last_progress_at IS '最近 report_progress 时间，无进展检测依据';
COMMENT ON COLUMN sessions.last_activity_at IS '最近活动（含用户消息），调度员空闲回收依据';
COMMENT ON COLUMN sessions.created_at IS '创建时间';
COMMENT ON COLUMN sessions.updated_at IS '更新时间';

-- ---------------------------------------------------------------------
-- worktrees（来源：worker-channel.yaml worktree.*；runtimes.yaml runtimeGc；S03 Step 11、S05 EX-19.1）
-- ---------------------------------------------------------------------
CREATE TABLE worktrees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runtime_id    UUID NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  repo_name     TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  path          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'failed', 'removed')),
  size_bytes    BIGINT,
  context_version INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  UNIQUE (runtime_id, path)
);
COMMENT ON TABLE worktrees IS 'runtime 上为任务创建的 git worktree；终态后保留 3 天或磁盘高水位时回收';
COMMENT ON COLUMN worktrees.id IS '主键';
COMMENT ON COLUMN worktrees.task_id IS '所属任务';
COMMENT ON COLUMN worktrees.runtime_id IS '所在 runtime';
COMMENT ON COLUMN worktrees.repo_name IS '仓库 owner/name';
COMMENT ON COLUMN worktrees.base_branch IS '基线分支';
COMMENT ON COLUMN worktrees.branch_name IS '工作分支 foreman/<key>';
COMMENT ON COLUMN worktrees.path IS '绝对路径';
COMMENT ON COLUMN worktrees.state IS '状态';
COMMENT ON COLUMN worktrees.size_bytes IS '最近一次统计的占用';
COMMENT ON COLUMN worktrees.context_version IS '写入的 context.md 版本';
COMMENT ON COLUMN worktrees.created_at IS '创建时间';
COMMENT ON COLUMN worktrees.removed_at IS '回收时间';

ALTER TABLE sessions ADD CONSTRAINT sessions_worktree_fk FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- trust_counters（来源：approvals.yaml TrustCounter；S06 Step 2–3、Step 19）
-- ---------------------------------------------------------------------
CREATE TABLE trust_counters (
  action_type        TEXT PRIMARY KEY CHECK (action_type IN (
                       'triage_confirm', 'start_implement', 'create_pr', 'start_pick', 'resolve_conflict_push',
                       'reply_review', 'rerun_ci', 'merge_master', 'merge_release',
                       'jira_transition_in_progress', 'jira_done', 'feishu_reply', 'jira_comment')),
  mode               TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto', 'locked')),
  streak             INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  threshold          INTEGER NOT NULL DEFAULT 5 CHECK (threshold >= 1),
  total_confirmed    INTEGER NOT NULL DEFAULT 0,
  total_rejected     INTEGER NOT NULL DEFAULT 0,
  last_confirmed_at  TIMESTAMPTZ,
  last_rejected_at   TIMESTAMPTZ,
  promoted_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE trust_counters IS '信任升级计数，按动作类型一行。连续 threshold 次原样确认升级为 auto；否决清零回 manual；locked 永远人工';
COMMENT ON COLUMN trust_counters.action_type IS '动作类型，主键';
COMMENT ON COLUMN trust_counters.mode IS 'manual / auto / locked';
COMMENT ON COLUMN trust_counters.streak IS '连续原样确认数';
COMMENT ON COLUMN trust_counters.threshold IS '升级阈值，默认 5';
COMMENT ON COLUMN trust_counters.total_confirmed IS '累计确认数（统计）';
COMMENT ON COLUMN trust_counters.total_rejected IS '累计否决数（统计）';
COMMENT ON COLUMN trust_counters.last_confirmed_at IS '最近确认时间';
COMMENT ON COLUMN trust_counters.last_rejected_at IS '最近否决时间';
COMMENT ON COLUMN trust_counters.promoted_at IS '升级为 auto 的时间';
COMMENT ON COLUMN trust_counters.updated_at IS '更新时间';

INSERT INTO trust_counters (action_type, mode) VALUES
  ('triage_confirm', 'manual'), ('start_implement', 'manual'), ('create_pr', 'manual'),
  ('start_pick', 'manual'), ('resolve_conflict_push', 'manual'), ('reply_review', 'manual'),
  ('rerun_ci', 'manual'), ('merge_master', 'manual'), ('merge_release', 'locked'),
  ('jira_transition_in_progress', 'manual'), ('jira_done', 'locked'), ('feishu_reply', 'manual'),
  ('jira_comment', 'manual');

-- ---------------------------------------------------------------------
-- approvals（来源：approvals.yaml Approval/decideApproval；mcp.yaml request_approval；S06）
-- ---------------------------------------------------------------------
CREATE TABLE approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                TEXT NOT NULL UNIQUE CHECK (key ~ '^A-[0-9]+$'),
  task_id            UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id         UUID REFERENCES sessions(id) ON DELETE SET NULL,
  action_type        TEXT NOT NULL REFERENCES trust_counters(action_type),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto_approved', 'superseded', 'failed', 'expired')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  body_hash          TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  trust_mode_snapshot TEXT NOT NULL CHECK (trust_mode_snapshot IN ('manual', 'auto', 'locked')),
  trust_streak_snapshot INTEGER NOT NULL DEFAULT 0,
  feishu_message_id  TEXT,
  feishu_deferred    BOOLEAN NOT NULL DEFAULT false,
  decided_via        TEXT CHECK (decided_via IS NULL OR decided_via IN ('panel', 'feishu', 'auto')),
  decided_at         TIMESTAMPTZ,
  modified           BOOLEAN NOT NULL DEFAULT false,
  final_body         TEXT,
  comment            TEXT,
  superseded_by      UUID REFERENCES approvals(id) ON DELETE SET NULL,
  action_id          UUID,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE approvals IS '审批对象。面板与飞书等价，先到先得靠 UPDATE ... WHERE status=pending AND body_hash=... 条件更新';
COMMENT ON COLUMN approvals.id IS '主键';
COMMENT ON COLUMN approvals.key IS '公开 key A-<seq>';
COMMENT ON COLUMN approvals.task_id IS '所属任务';
COMMENT ON COLUMN approvals.session_id IS '发起审批的会话（MCP request_approval）；内部发起为 NULL';
COMMENT ON COLUMN approvals.action_type IS '动作类型';
COMMENT ON COLUMN approvals.status IS '状态';
COMMENT ON COLUMN approvals.title IS '一行标题';
COMMENT ON COLUMN approvals.body IS '动作正文（markdown）';
COMMENT ON COLUMN approvals.body_hash IS '正文 sha256，决定时必须匹配（S06 EX-18.2）';
COMMENT ON COLUMN approvals.payload IS '结构化参数，执行时使用';
COMMENT ON COLUMN approvals.trust_mode_snapshot IS '创建时的信任模式快照';
COMMENT ON COLUMN approvals.trust_streak_snapshot IS '创建时的连续确认数快照';
COMMENT ON COLUMN approvals.feishu_message_id IS '飞书审批消息 id，reaction 事件靠它匹配';
COMMENT ON COLUMN approvals.feishu_deferred IS '当日推送超限延后合并（S01 EX-28.2）';
COMMENT ON COLUMN approvals.decided_via IS '决定通道';
COMMENT ON COLUMN approvals.decided_at IS '决定时间';
COMMENT ON COLUMN approvals.modified IS '修改后确认，不计信任';
COMMENT ON COLUMN approvals.final_body IS '修改后的正文';
COMMENT ON COLUMN approvals.comment IS '否决原因或备注';
COMMENT ON COLUMN approvals.superseded_by IS '正文变更后取代本条的新审批';
COMMENT ON COLUMN approvals.action_id IS '执行后的动作记录（外键在 actions 建表后添加）';
COMMENT ON COLUMN approvals.expires_at IS '阻塞等待的截止时间（30 分钟）';
COMMENT ON COLUMN approvals.created_at IS '创建时间';
COMMENT ON COLUMN approvals.updated_at IS '更新时间';

ALTER TABLE triage_cards ADD CONSTRAINT triage_cards_approval_fk FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL;
ALTER TABLE triage_cards ADD CONSTRAINT triage_cards_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- actions（来源：approvals.yaml revokeAction；S06 Step 20、Step 28–32）
-- ---------------------------------------------------------------------
CREATE TABLE actions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id    UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  task_id        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_type    TEXT NOT NULL REFERENCES trust_counters(action_type),
  executor       TEXT NOT NULL CHECK (executor IN ('agent', 'center')),
  status         TEXT NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'succeeded', 'failed', 'reverted', 'not_revocable')),
  auto           BOOLEAN NOT NULL DEFAULT false,
  result         JSONB NOT NULL DEFAULT '{}'::jsonb,
  revocable_until TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoke_reason  TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE actions IS '审批通过后实际执行的动作记录；自动执行的动作 7 天内可事后否决并补偿';
COMMENT ON COLUMN actions.id IS '主键';
COMMENT ON COLUMN actions.approval_id IS '对应审批';
COMMENT ON COLUMN actions.task_id IS '所属任务';
COMMENT ON COLUMN actions.action_type IS '动作类型';
COMMENT ON COLUMN actions.executor IS 'agent 由会话执行（MCP 返回后）/ center 由中心执行器执行';
COMMENT ON COLUMN actions.status IS '状态';
COMMENT ON COLUMN actions.auto IS '是否信任自动执行';
COMMENT ON COLUMN actions.result IS '执行结果，如 Jira 评论 id、飞书消息 id、PR url';
COMMENT ON COLUMN actions.revocable_until IS '可回滚截止时间（创建 + 7 天）';
COMMENT ON COLUMN actions.revoked_at IS '回滚时间';
COMMENT ON COLUMN actions.revoke_reason IS '回滚原因';
COMMENT ON COLUMN actions.error IS '执行或补偿错误';
COMMENT ON COLUMN actions.created_at IS '创建时间';
COMMENT ON COLUMN actions.updated_at IS '更新时间';

ALTER TABLE approvals ADD CONSTRAINT approvals_action_fk FOREIGN KEY (action_id) REFERENCES actions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- questions（来源：tasks.yaml Question/postTaskMessage；mcp.yaml ask_user；S07 Step 13–28）
-- ---------------------------------------------------------------------
CREATE TABLE questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  options        TEXT[] NOT NULL DEFAULT '{}',
  origin         TEXT NOT NULL DEFAULT 'mcp' CHECK (origin IN ('mcp', 'hook')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'timeout')),
  answer         TEXT,
  answered_via   TEXT CHECK (answered_via IS NULL OR answered_via IN ('panel', 'feishu')),
  feishu_message_id TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  asked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at    TIMESTAMPTZ
);
COMMENT ON TABLE questions IS 'agent 向用户提出的待答问题（ask_user 或钩子推断）；回答唤醒挂起的 MCP 请求或触发 session.resume';
COMMENT ON COLUMN questions.id IS '主键';
COMMENT ON COLUMN questions.task_id IS '所属任务';
COMMENT ON COLUMN questions.session_id IS '提问的会话';
COMMENT ON COLUMN questions.text IS '问题正文';
COMMENT ON COLUMN questions.options IS '可选项，按按钮渲染';
COMMENT ON COLUMN questions.origin IS 'mcp 来自 ask_user / hook 来自 agent_needs_input 钩子推断（S07 EX-19.1）';
COMMENT ON COLUMN questions.status IS '状态';
COMMENT ON COLUMN questions.answer IS '回答';
COMMENT ON COLUMN questions.answered_via IS '回答通道';
COMMENT ON COLUMN questions.feishu_message_id IS '飞书「需要你回答」消息 id，回复靠 parent_id 匹配';
COMMENT ON COLUMN questions.expires_at IS 'MCP 挂起截止（30 分钟）';
COMMENT ON COLUMN questions.asked_at IS '提问时间';
COMMENT ON COLUMN questions.answered_at IS '回答时间';

-- ---------------------------------------------------------------------
-- task_drafts（来源：tasks.yaml TaskDraft/confirmDraft；mcp.yaml propose_task；S04 Step 27–34）
-- ---------------------------------------------------------------------
CREATE TABLE task_drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
  origin        TEXT NOT NULL DEFAULT 'dispatcher' CHECK (origin IN ('dispatcher', 'command')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'cancelled', 'expired')),
  fields        JSONB NOT NULL,
  task_id       UUID REFERENCES tasks(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE task_drafts IS '调度员或斜杠命令产出的任务草案，用户确认后创建任务；24 小时过期';
COMMENT ON COLUMN task_drafts.id IS '主键';
COMMENT ON COLUMN task_drafts.channel_id IS '所属频道';
COMMENT ON COLUMN task_drafts.session_id IS '提出草案的调度员会话';
COMMENT ON COLUMN task_drafts.origin IS 'dispatcher 调度员 / command 斜杠命令直出';
COMMENT ON COLUMN task_drafts.status IS '状态';
COMMENT ON COLUMN task_drafts.fields IS '草案字段 {source, sourceTitle, repo, repoSource, path, pickTargets, runtime, agent, note}';
COMMENT ON COLUMN task_drafts.task_id IS '确认后创建的任务';
COMMENT ON COLUMN task_drafts.expires_at IS '过期时间';
COMMENT ON COLUMN task_drafts.created_at IS '创建时间';
COMMENT ON COLUMN task_drafts.updated_at IS '更新时间';

-- ---------------------------------------------------------------------
-- messages（来源：tasks.yaml Message；channels.yaml；mcp.yaml report_progress；S04、S07）
-- ---------------------------------------------------------------------
CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           BIGSERIAL NOT NULL UNIQUE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  task_id       UUID REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'system', 'progress', 'ask', 'approval_card', 'artifact_card', 'failure_card',
                  'draft_card', 'triage_card', 'user', 'user_reply', 'clarification', 'dispatcher')),
  author        TEXT NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  ref_type      TEXT CHECK (ref_type IS NULL OR ref_type IN ('approval', 'draft', 'question', 'artifact', 'action')),
  ref_id        UUID,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery      TEXT CHECK (delivery IS NULL OR delivery IN ('delivered', 'queued')),
  delivered_at  TIMESTAMPTZ,
  log_from      TIMESTAMPTZ,
  log_to        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE messages IS '频道与线程的消息流。task_id 非空为线程消息；卡片类消息通过 ref_type/ref_id 引用对象';
COMMENT ON COLUMN messages.id IS '主键，也是分页游标';
COMMENT ON COLUMN messages.seq IS '线程内单调序号：同一时刻（注入时钟冻结）多条消息按写入顺序排序与游标分页';
COMMENT ON COLUMN messages.channel_id IS '所属频道';
COMMENT ON COLUMN messages.task_id IS '所属线程（根任务）；频道消息为 NULL';
COMMENT ON COLUMN messages.session_id IS '产生本消息的会话';
COMMENT ON COLUMN messages.kind IS '消息类型';
COMMENT ON COLUMN messages.author IS '作者：user / system / dispatcher / claude / codex';
COMMENT ON COLUMN messages.text IS '文本';
COMMENT ON COLUMN messages.ref_type IS '引用对象类型';
COMMENT ON COLUMN messages.ref_id IS '引用对象 id';
COMMENT ON COLUMN messages.payload IS '卡片结构化内容';
COMMENT ON COLUMN messages.delivery IS '用户消息送入会话的状态；runtime 离线时 queued（S07 EX-37.1）';
COMMENT ON COLUMN messages.delivered_at IS '送入会话时间';
COMMENT ON COLUMN messages.log_from IS '进展摘要覆盖的日志起始时间，展开日志用';
COMMENT ON COLUMN messages.log_to IS '进展摘要覆盖的日志结束时间';
COMMENT ON COLUMN messages.created_at IS '创建时间';

-- ---------------------------------------------------------------------
-- artifacts（来源：tasks.yaml Artifact；mcp.yaml deliver；S03 Step 27–29）
-- ---------------------------------------------------------------------
CREATE TABLE artifacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('pr', 'doc', 'branch', 'triage', 'candidates', 'review')),
  url           TEXT,
  title         TEXT,
  path          TEXT,
  branch        TEXT,
  content       TEXT,
  diff_stat     JSONB,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  mirrored_to   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE artifacts IS 'agent 交付的产物：PR、方案文档、demo 分支、分流结果、候选列表、review 结论（0003 迁移补入 review）';
COMMENT ON COLUMN artifacts.id IS '主键';
COMMENT ON COLUMN artifacts.task_id IS '所属任务';
COMMENT ON COLUMN artifacts.session_id IS '交付的会话';
COMMENT ON COLUMN artifacts.kind IS '产物类型';
COMMENT ON COLUMN artifacts.url IS 'PR 链接';
COMMENT ON COLUMN artifacts.title IS '标题';
COMMENT ON COLUMN artifacts.path IS '文档在 worktree 内的相对路径';
COMMENT ON COLUMN artifacts.branch IS 'demo 分支名';
COMMENT ON COLUMN artifacts.content IS '文档全文';
COMMENT ON COLUMN artifacts.diff_stat IS '{additions, deletions, files}';
COMMENT ON COLUMN artifacts.payload IS '其他结构化内容';
COMMENT ON COLUMN artifacts.mirrored_to IS '已镜像到的来源 [{type: jira_comment|feishu_reply, id, at}]';
COMMENT ON COLUMN artifacts.created_at IS '创建时间';

-- ---------------------------------------------------------------------
-- candidates（来源：approvals.yaml Candidate；S02 Step 18–30）
-- ---------------------------------------------------------------------
CREATE TABLE candidates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type    TEXT NOT NULL DEFAULT 'feishu' CHECK (source_type IN ('feishu')),
  message_id     TEXT NOT NULL,
  chat_id        TEXT,
  chat_name      TEXT,
  sender         TEXT,
  text           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  confidence     NUMERIC(4,3) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'intaken', 'dismissed')),
  task_id        UUID REFERENCES tasks(id) ON DELETE SET NULL,
  session_id     UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ,
  UNIQUE (source_type, message_id)
);
COMMENT ON TABLE candidates IS 'LLM 每小时扫描出的疑似需求，只进面板收件箱候选区，不推飞书';
COMMENT ON COLUMN candidates.id IS '主键';
COMMENT ON COLUMN candidates.source_type IS '来源类型，M1 只有飞书';
COMMENT ON COLUMN candidates.message_id IS '飞书消息 id，去重键';
COMMENT ON COLUMN candidates.chat_id IS '会话 id';
COMMENT ON COLUMN candidates.chat_name IS '群名或私聊对象';
COMMENT ON COLUMN candidates.sender IS '发送者';
COMMENT ON COLUMN candidates.text IS '消息文本';
COMMENT ON COLUMN candidates.reason IS 'LLM 判定理由';
COMMENT ON COLUMN candidates.confidence IS '置信度';
COMMENT ON COLUMN candidates.status IS '状态';
COMMENT ON COLUMN candidates.task_id IS '入库后的任务';
COMMENT ON COLUMN candidates.session_id IS '扫描会话';
COMMENT ON COLUMN candidates.created_at IS '创建时间';
COMMENT ON COLUMN candidates.decided_at IS '入库或忽略时间';

-- ---------------------------------------------------------------------
-- jobs（来源：worker-channel.yaml job.run/job.result；S01 Step 1–9、S04 Step 19–25、调度器）
-- ---------------------------------------------------------------------
CREATE TABLE jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL CHECK (kind IN ('jira-poll', 'jira-lookup', 'jira-comment', 'gh-pr-view', 'merge-tree-check', 'candidate-scan', 'worktree-gc', 'dispatcher-idle', 'heartbeat-check', 'progress-watch', 'feishu-digest', 'notification-retry', 'code-locate', 'context-retry', 'dispatch', 'git-publish')),
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatched', 'running', 'succeeded', 'failed', 'skipped')),
  runtime_id     UUID REFERENCES runtimes(id) ON DELETE SET NULL,
  required_label TEXT,
  args           JSONB NOT NULL DEFAULT '{}'::jsonb,
  result         JSONB,
  error_code     TEXT,
  error_message  TEXT,
  dedupe_key     TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at  TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE jobs IS '系统作业与调度器 tick 的持久化记录；中心重启后从 queued/dispatched 恢复';
COMMENT ON COLUMN jobs.id IS '主键，也是 worker 通道的 commandId';
COMMENT ON COLUMN jobs.kind IS '作业种类';
COMMENT ON COLUMN jobs.status IS '状态';
COMMENT ON COLUMN jobs.runtime_id IS '派往的 runtime；中心自执行为 NULL';
COMMENT ON COLUMN jobs.required_label IS '要求的 runtime 标签，如 vpn:jira';
COMMENT ON COLUMN jobs.args IS '参数';
COMMENT ON COLUMN jobs.result IS '结果';
COMMENT ON COLUMN jobs.error_code IS '错误码';
COMMENT ON COLUMN jobs.error_message IS '错误信息';
COMMENT ON COLUMN jobs.dedupe_key IS '去重键，同键的 queued 作业不重复排队（S01 EX-2.1）';
COMMENT ON COLUMN jobs.attempts IS '尝试次数';
COMMENT ON COLUMN jobs.scheduled_at IS '计划执行时间';
COMMENT ON COLUMN jobs.dispatched_at IS '派发时间';
COMMENT ON COLUMN jobs.finished_at IS '结束时间';
COMMENT ON COLUMN jobs.created_at IS '创建时间';

-- ---------------------------------------------------------------------
-- source_health（来源：runtimes.yaml SourceHealth；S01 EX-2.1 / EX-6.1）
-- ---------------------------------------------------------------------
CREATE TABLE source_health (
  source                TEXT PRIMARY KEY CHECK (source IN ('jira', 'feishu', 'github')),
  status                TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('ok', 'unreachable', 'no_runtime', 'disabled')),
  watermark             TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  executed_on           TEXT,
  last_alert_at         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE source_health IS '来源系统健康度与轮询水位线，一来源一行';
COMMENT ON COLUMN source_health.source IS '来源';
COMMENT ON COLUMN source_health.status IS '状态';
COMMENT ON COLUMN source_health.watermark IS '轮询水位线（Jira 为 updated 最大值）';
COMMENT ON COLUMN source_health.last_success_at IS '最近成功时间';
COMMENT ON COLUMN source_health.last_error IS '最近错误';
COMMENT ON COLUMN source_health.consecutive_failures IS '连续失败次数，≥3 推飞书告警';
COMMENT ON COLUMN source_health.executed_on IS '执行位置：runtime 名或 center';
COMMENT ON COLUMN source_health.last_alert_at IS '最近告警时间，限频每小时一次';
COMMENT ON COLUMN source_health.updated_at IS '更新时间';

INSERT INTO source_health (source, status) VALUES ('jira', 'disabled'), ('feishu', 'disabled'), ('github', 'disabled');

-- ---------------------------------------------------------------------
-- notifications（来源：S01 Step 27–31、S06 Step 7–10、S07 Step 17；EX-28.1 重试）
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          TEXT NOT NULL DEFAULT 'feishu' CHECK (channel IN ('feishu')),
  kind             TEXT NOT NULL CHECK (kind IN ('approval', 'question', 'intake_ack', 'alert', 'digest', 'reply')),
  ref_type         TEXT CHECK (ref_type IS NULL OR ref_type IN ('approval', 'question', 'task', 'source')),
  ref_id           UUID,
  target           TEXT NOT NULL,
  reply_to_message_id TEXT,
  text             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'deferred')),
  external_message_id TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE notifications IS '对外通知的发送记录与重试队列（M1 只有飞书）；每日推送上限按 kind=approval 且 sent 计数';
COMMENT ON COLUMN notifications.id IS '主键';
COMMENT ON COLUMN notifications.channel IS '通道';
COMMENT ON COLUMN notifications.kind IS '通知种类';
COMMENT ON COLUMN notifications.ref_type IS '引用对象类型';
COMMENT ON COLUMN notifications.ref_id IS '引用对象 id';
COMMENT ON COLUMN notifications.target IS '目标：open_id 或 chat_id';
COMMENT ON COLUMN notifications.reply_to_message_id IS '作为回复时的父消息 id';
COMMENT ON COLUMN notifications.text IS '正文';
COMMENT ON COLUMN notifications.status IS '状态；deferred 为超限延后';
COMMENT ON COLUMN notifications.external_message_id IS '发送成功后的飞书 message_id';
COMMENT ON COLUMN notifications.attempts IS '尝试次数，最多 3';
COMMENT ON COLUMN notifications.last_error IS '最近错误';
COMMENT ON COLUMN notifications.next_attempt_at IS '下次重试时间';
COMMENT ON COLUMN notifications.sent_at IS '发送时间';
COMMENT ON COLUMN notifications.created_at IS '创建时间';

-- ---------------------------------------------------------------------
-- feishu_events（来源：S02 Step 2–4、S06 Step 12、S07 Step 23；幂等去重）
-- ---------------------------------------------------------------------
CREATE TABLE feishu_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  message_id   TEXT,
  operator_open_id TEXT,
  handled      TEXT NOT NULL DEFAULT 'pending' CHECK (handled IN ('pending', 'processed', 'ignored', 'failed')),
  ignore_reason TEXT,
  raw          JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
COMMENT ON TABLE feishu_events IS '飞书事件的幂等登记；lark-cli 长连接可能重放，按 event_id 去重';
COMMENT ON COLUMN feishu_events.event_id IS '飞书事件 id，主键';
COMMENT ON COLUMN feishu_events.event_type IS '事件类型，如 im.message.reaction.created_v1';
COMMENT ON COLUMN feishu_events.message_id IS '相关消息 id';
COMMENT ON COLUMN feishu_events.operator_open_id IS '操作者';
COMMENT ON COLUMN feishu_events.handled IS '处理结果';
COMMENT ON COLUMN feishu_events.ignore_reason IS '忽略原因（非 owner、表情不匹配等）';
COMMENT ON COLUMN feishu_events.raw IS '原始事件';
COMMENT ON COLUMN feishu_events.received_at IS '接收时间';
COMMENT ON COLUMN feishu_events.processed_at IS '处理时间';

-- ---------------------------------------------------------------------
-- events（来源：panel-events.yaml EventEnvelope；所有场景的"事件先落库再广播"）
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         BIGSERIAL NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  task_id     UUID REFERENCES tasks(id) ON DELETE CASCADE,
  channel_id  UUID REFERENCES channels(id) ON DELETE CASCADE,
  session_id  UUID,
  actor       TEXT NOT NULL DEFAULT 'system',
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  broadcast   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE events IS '领域事件日志。每个状态变更在同一事务写入；提交后按 seq 顺序广播到面板 WebSocket，断线用 seq 补发';
COMMENT ON COLUMN events.id IS '主键，即面板事件 id';
COMMENT ON COLUMN events.seq IS '单调递增序号，断线补发依据';
COMMENT ON COLUMN events.type IS '事件类型，如 inbox.new、task.updated、approval.decided';
COMMENT ON COLUMN events.task_id IS '相关任务';
COMMENT ON COLUMN events.channel_id IS '相关频道';
COMMENT ON COLUMN events.session_id IS '相关会话（不建外键，会话删除后事件保留）';
COMMENT ON COLUMN events.actor IS '触发者：user / system / agent 名 / feishu';
COMMENT ON COLUMN events.payload IS '事件内容';
COMMENT ON COLUMN events.broadcast IS '是否需要推送到面板';
COMMENT ON COLUMN events.created_at IS '创建时间';

-- =====================================================================
-- 索引
-- =====================================================================

-- tasks：频道线程列表按活动倒序（channels.yaml listChannelThreads）
CREATE INDEX idx_tasks_channel_activity ON tasks (channel_id, last_activity_at DESC) WHERE parent_id IS NULL;
-- tasks：子任务查询与任务树（tasks.yaml getTask）
CREATE INDEX idx_tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
-- tasks：收件箱失败项与队列重排（approvals.yaml getInbox、S03 EX-7.2）
CREATE INDEX idx_tasks_state ON tasks (state);
-- tasks：worktree 回收按终态时间（S05 EX-19.1）
CREATE INDEX idx_tasks_terminal_at ON tasks (terminal_at) WHERE terminal_at IS NOT NULL;

-- source_items：Jira 水位线取 max(external_updated_at)（S01 Step 2）
CREATE INDEX idx_source_items_type_updated ON source_items (source_type, external_updated_at DESC);

-- sessions：并发闸门按 runtime + agent 统计运行中会话（S03 Step 8、EX-7.2）
CREATE INDEX idx_sessions_runtime_agent_active ON sessions (runtime_id, agent) WHERE state IN ('planned', 'running', 'waiting_input');
-- sessions：任务的会话列表与当前会话
CREATE INDEX idx_sessions_task ON sessions (task_id, created_at DESC);
-- sessions：频道调度员会话查找（S04 Step 11）
CREATE INDEX idx_sessions_channel_dispatcher ON sessions (channel_id) WHERE kind = 'dispatcher' AND state IN ('running', 'waiting_input');
-- sessions：无进展检测（S07 Step 48）
CREATE INDEX idx_sessions_running_progress ON sessions (last_progress_at) WHERE state = 'running';
-- sessions：worker 上报 agent 会话 id 时反查
CREATE INDEX idx_sessions_agent_session ON sessions (runtime_id, agent_session_id);

-- worktrees：按 runtime 与状态回收
CREATE INDEX idx_worktrees_runtime_state ON worktrees (runtime_id, state);
CREATE INDEX idx_worktrees_task ON worktrees (task_id);

-- approvals：收件箱待处理项（getInbox）
CREATE INDEX idx_approvals_pending ON approvals (created_at) WHERE status = 'pending';
-- approvals：任务下的审批
CREATE INDEX idx_approvals_task ON approvals (task_id, created_at DESC);
-- approvals：飞书 reaction 事件按消息 id 匹配（S06 Step 13）
CREATE UNIQUE INDEX idx_approvals_feishu_message ON approvals (feishu_message_id) WHERE feishu_message_id IS NOT NULL;
-- approvals：信任视图按类型统计自动执行（listTrust）
CREATE INDEX idx_approvals_type_status_created ON approvals (action_type, status, created_at DESC);

-- actions：可回滚窗口查询（revokeAction）
CREATE INDEX idx_actions_task ON actions (task_id, created_at DESC);
CREATE INDEX idx_actions_revocable ON actions (revocable_until) WHERE auto = true AND status = 'succeeded';

-- questions：任务最新 open 问题（postTaskMessage）与收件箱
CREATE INDEX idx_questions_task_open ON questions (task_id, asked_at DESC) WHERE status = 'open';
-- questions：飞书回复按 parent 消息匹配（S07 Step 24）
CREATE UNIQUE INDEX idx_questions_feishu_message ON questions (feishu_message_id) WHERE feishu_message_id IS NOT NULL;
-- questions：超时扫描
CREATE INDEX idx_questions_expires ON questions (expires_at) WHERE status = 'open';

-- task_drafts：频道内打开的草案与过期扫描
CREATE INDEX idx_task_drafts_channel_open ON task_drafts (channel_id, created_at DESC) WHERE status = 'open';

-- messages：线程消息流游标分页（listTaskMessages）
CREATE INDEX idx_messages_task_created ON messages (task_id, created_at, id) WHERE task_id IS NOT NULL;
-- messages：频道消息流（listChannelMessages），仅频道级消息
CREATE INDEX idx_messages_channel_created ON messages (channel_id, created_at, id) WHERE task_id IS NULL;
-- messages：runtime 上线后按顺序送入排队消息（S07 EX-37.1）
CREATE INDEX idx_messages_queued ON messages (task_id, created_at) WHERE delivery = 'queued';

-- artifacts：任务产物
CREATE INDEX idx_artifacts_task ON artifacts (task_id, created_at DESC);

-- candidates：收件箱候选区
CREATE INDEX idx_candidates_open ON candidates (created_at DESC) WHERE status = 'open';

-- jobs：调度器取待派作业与去重（S01 EX-2.1）
CREATE INDEX idx_jobs_status_scheduled ON jobs (status, scheduled_at) WHERE status IN ('queued', 'dispatched');
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'dispatched', 'running');

-- notifications：重试队列与每日计数
CREATE INDEX idx_notifications_retry ON notifications (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_notifications_daily ON notifications (kind, sent_at) WHERE status = 'sent';

-- feishu_events：按消息 id 反查
CREATE INDEX idx_feishu_events_message ON feishu_events (message_id);

-- events：面板断线补发按 seq；线程事件按任务
CREATE INDEX idx_events_task_seq ON events (task_id, seq);
CREATE INDEX idx_events_created ON events (created_at);

-- =====================================================================
-- 行级安全
-- 单用户系统：应用以 foreman_app 角色连接，策略为全量访问；启用 RLS 是为了
-- 将来引入多用户时只需替换策略而不动表结构。
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foreman_app') THEN
    CREATE ROLE foreman_app NOLOGIN;
  END IF;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'runtimes','channels','tasks','source_items','context_packs','triage_cards','sessions','worktrees',
    'trust_counters','approvals','actions','questions','task_drafts','messages','artifacts','candidates',
    'jobs','source_health','notifications','feishu_events','events'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_app_all ON %I FOR ALL TO foreman_app USING (true) WITH CHECK (true)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO foreman_app', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE task_key_seq, approval_key_seq, events_seq_seq TO foreman_app;

-- =====================================================================
-- 触发器：updated_at 自动刷新（有 updated_at 列的表）
-- =====================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'runtimes','channels','tasks','context_packs','triage_cards','sessions','trust_counters',
    'approvals','actions','task_drafts','source_health'])
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
