/**
 * 中心 ↔ worker WebSocket 协议（来源：logos/resources/api/worker-channel.yaml）
 * 所有消息为 Envelope；指令类消息的 id 即 commandId，用于幂等与回复关联。
 */
import { z } from 'zod';
import { AGENTS, TRANSPORTS, SESSION_STATES, SESSION_KINDS, JOB_KINDS } from './constants.js';

export const Envelope = z.object({
  type: z.string(),
  id: z.string().uuid(),
  ref: z.string().uuid().nullable().optional(),
  ts: z.string(),
  payload: z.record(z.unknown()).default({}),
});
export type Envelope = z.infer<typeof Envelope>;

export const DiskInfo = z.object({
  path: z.string().optional(),
  usedRatio: z.number().min(0).max(1).optional(),
  freeBytes: z.number().int().optional(),
});

export const AgentConfig = z.object({
  bin: z.string(),
  version: z.string().nullable().optional(),
  maxConcurrent: z.number().int().min(1),
});

export const RepoConfig = z.object({
  main: z.string(),
  worktreeRoot: z.string(),
  pushRemote: z.string().optional(),
});

export const Register = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  instanceId: z.string().uuid(),
  version: z.string(),
  transport: z.enum(TRANSPORTS),
  labels: z.array(z.string()),
  agents: z.record(AgentConfig),
  repos: z.record(RepoConfig),
  disk: DiskInfo.optional(),
  capabilities: z.array(z.enum(['jira-poll', 'jira-lookup', 'gh', 'merge-tree', 'rg'])).default([]),
});
export type Register = z.infer<typeof Register>;

export const RegisterAck = z.object({
  runtimeId: z.string().uuid(),
  heartbeatSeconds: z.number().int(),
  pendingCommands: z.array(Envelope),
});
export type RegisterAck = z.infer<typeof RegisterAck>;

export const Heartbeat = z.object({
  load: z.number().nullable().optional(),
  disk: DiskInfo.optional(),
  sessions: z.record(z.number().int()).default({}),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const JobRun = z.object({
  kind: z.enum(JOB_KINDS),
  args: z.record(z.unknown()).default({}),
  timeoutSeconds: z.number().int().default(60),
});
export const JobResult = z.object({
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: z.object({ code: z.enum(['SOURCE_UNREACHABLE', 'NOT_FOUND', 'TIMEOUT', 'INTERNAL']), message: z.string() }).nullable().optional(),
});

export const WorktreeCreate = z.object({
  taskKey: z.string(),
  repo: z.string(),
  baseBranch: z.string(),
  branchName: z.string().optional(),
  buildEnv: z.record(z.string()).optional(),
  contextMarkdown: z.string().optional(),
  taskJson: z.record(z.unknown()).optional(),
  hooks: z.record(z.unknown()).optional(),
  reuseIfExists: z.boolean().default(true),
  fetchFirst: z.boolean().optional(),
});
export const WorktreeReady = z.object({
  taskKey: z.string(),
  path: z.string(),
  branchName: z.string(),
  reused: z.boolean(),
});
export const WorktreeGc = z.object({
  policy: z.enum(['retain_days', 'high_watermark']),
  dryRun: z.boolean(),
  retainDays: z.number().int().default(3),
  highWatermark: z.number().default(0.85),
  protectedTaskKeys: z.array(z.string()).default([]),
  candidates: z.array(z.object({ taskKey: z.string(), path: z.string(), terminalAt: z.string().nullable() })).default([]),
});
export const GcResult = z.object({
  dryRun: z.boolean(),
  removed: z.array(z.object({ taskKey: z.string(), path: z.string(), terminalAt: z.string().nullable().optional(), bytes: z.number().int().optional() })),
  skippedRunning: z.number().int().default(0),
  freedBytes: z.number().int().default(0),
  diskUsedRatioAfter: z.number().nullable().optional(),
});
export type GcResult = z.infer<typeof GcResult>;

export const SessionStart = z.object({
  sessionId: z.string().uuid(),
  taskKey: z.string().nullable(),
  kind: z.enum(SESSION_KINDS),
  agent: z.enum(AGENTS),
  model: z.string().nullable().optional(),
  prompt: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  mcp: z.object({ url: z.string(), token: z.string() }),
  env: z.record(z.string()).optional(),
  timeoutMinutes: z.number().int().nullable().optional(),
}).superRefine((v, ctx) => {
  // 架构 2.5：agent 只走订阅版 CLI，禁止通过 env 注入 API key
  for (const k of Object.keys(v.env ?? {})) if (FORBIDDEN_ENV_KEYS.includes(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env', k], message: `FORBIDDEN_ENV: ${k}` });
});
/** 禁止下发给 agent 会话的环境变量（按 API 计费的密钥） */
export const FORBIDDEN_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export const SessionStarted = z.object({
  sessionId: z.string().uuid(),
  agentSessionId: z.string(),
  startedAt: z.string(),
  pid: z.number().int().nullable().optional(),
});
export const SessionResume = z.object({ sessionId: z.string().uuid(), text: z.string() });
export const SessionStop = z.object({ sessionId: z.string().uuid(), reason: z.enum(['user', 'idle', 'timeout', 'pause']).optional() });
export const SessionStateMsg = z.object({
  sessionId: z.string().uuid(),
  state: z.enum(SESSION_STATES),
  waitingFor: z.string().nullable().optional(),
  source: z.enum(['poll', 'hook', 'exit']),
  exitCode: z.number().int().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  observedAt: z.string(),
});
export const SessionList = z.object({
  sessions: z.array(z.object({
    sessionId: z.string().uuid(),
    agentSessionId: z.string().nullable().optional(),
    state: z.enum(SESSION_STATES),
  })),
});
export const SessionLogs = z.object({
  sessionId: z.string().uuid(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  limit: z.number().int().default(400),
});
export const SessionLogsResult = z.object({
  sessionId: z.string().uuid(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});
export const ErrorMessage = z.object({
  code: z.enum(['AUTH_INVALID', 'VERSION_UNSUPPORTED', 'RUNTIME_NAME_CONFLICT', 'WORKTREE_FAILED', 'AGENT_START_FAILED', 'RESUME_FAILED', 'UNKNOWN_COMMAND', 'INTERNAL', 'VALIDATION']),
  message: z.string(),
  detail: z.record(z.unknown()).optional(),
  retryable: z.boolean().optional(),
});

/** 消息类型 → payload schema */
export const WORKER_TO_CENTER = {
  register: Register,
  heartbeat: Heartbeat,
  'job.result': JobResult,
  'worktree.ready': WorktreeReady,
  'worktree.gc.result': GcResult,
  'session.started': SessionStarted,
  'session.state': SessionStateMsg,
  'session.list': SessionList,
  'session.logs.result': SessionLogsResult,
  error: ErrorMessage,
} as const;

export const CENTER_TO_WORKER = {
  'register.ack': RegisterAck,
  'job.run': JobRun,
  'worktree.create': WorktreeCreate,
  'worktree.gc': WorktreeGc,
  'session.start': SessionStart,
  'session.resume': SessionResume,
  'session.stop': SessionStop,
  'session.logs': SessionLogs,
  error: ErrorMessage,
} as const;

export type CenterToWorkerType = keyof typeof CENTER_TO_WORKER;
export type WorkerToCenterType = keyof typeof WORKER_TO_CENTER;

export function makeEnvelope(type: string, payload: Record<string, unknown>, opts?: { id?: string; ref?: string | null; ts?: string }): Envelope {
  return {
    type,
    id: opts?.id ?? crypto.randomUUID(),
    ref: opts?.ref ?? null,
    ts: opts?.ts ?? new Date().toISOString(),
    payload,
  };
}

/** 简单 semver 比较：a >= b */
export function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true;
}
