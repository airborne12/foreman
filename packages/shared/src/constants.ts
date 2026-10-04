/** 与 schema.sql / API YAML 对齐的枚举常量 */
export const AGENTS = ['codex'] as const;
export type AgentName = (typeof AGENTS)[number];

export const TRANSPORTS = ['direct', 'reverse-tunnel', 'local'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const TASK_STATES = [
  'draft', 'triaging', 'pending_decision', 'queued', 'running',
  'waiting_input', 'waiting_approval', 'failed', 'delivered', 'done', 'paused',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_KINDS = ['code', 'analysis', 'text', 'review', 'pr', 'branch'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_PATHS = ['fix', 'plan', 'proto'] as const;
export type TaskPath = (typeof TASK_PATHS)[number];

export const SESSION_STATES = ['planned', 'running', 'waiting_input', 'done', 'failed', 'stopped', 'lost'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_KINDS = ['implement', 'review', 'code_locate', 'plan', 'proto', 'dispatcher', 'candidate_scan'] as const;

export const JOB_KINDS = ['jira-poll', 'jira-lookup', 'jira-comment', 'gh-pr-view', 'merge-tree-check', 'git-publish'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const ACTION_TYPES = ['triage_confirm', 'start_implement', 'create_pr', 'start_pick', 'resolve_conflict_push', 'reply_review', 'rerun_ci', 'merge_master', 'merge_release', 'jira_transition_in_progress', 'jira_done', 'feishu_reply', 'jira_comment'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** MCP 阻塞工具最长等待（分钟）；代码定位会话超时（分钟） */
export const APPROVAL_WAIT_MINUTES = 30;
export const CODE_LOCATE_TIMEOUT_MINUTES = 15;
export const AGENT_START_TIMEOUT_SECONDS = 60;
export const SCHEDULER_JOBS = ['jira-poll', 'candidate-scan', 'worktree-gc', 'dispatcher-idle', 'heartbeat-check', 'progress-watch', 'feishu-digest'] as const;
export type SchedulerJob = (typeof SCHEDULER_JOBS)[number];

export const SOURCE_TYPES = ['jira', 'feishu', 'channel', 'cli', 'github'] as const;

/** 心跳与离线判定（S05 Step 18–23） */
export const HEARTBEAT_SECONDS = 30;
export const OFFLINE_AFTER_SECONDS = 90;
export const OFFLINE_ALERT_AFTER_SECONDS = 300;
/** worker 连接后必须在 5 秒内 register */
export const REGISTER_TIMEOUT_MS = 5000;
/** 中心接受的最低 worker 版本 */
export const MIN_WORKER_VERSION = '0.1.0';
export const CENTER_VERSION = '0.1.0';
