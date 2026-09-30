/**
 * worker.yaml / center.yaml 结构（来源：core-03-runtime-cli-design.md §3）
 */
import { z } from 'zod';
import { AgentConfig, RepoConfig } from './protocol.js';
import { TRANSPORTS } from './constants.js';

export const WorkerConfig = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  center: z.object({ url: z.string(), token: z.string() }),
  transport: z.enum(TRANSPORTS).default('direct'),
  labels: z.array(z.string()).default([]),
  agents: z.record(AgentConfig).default({}),
  repos: z.record(RepoConfig).default({}),
  build_env: z.record(z.record(z.record(z.string()))).default({}),
  worktree: z.object({
    retain_days: z.number().int().default(3),
    disk_high_watermark: z.number().default(0.85),
    disk_path: z.string().optional(),
  }).default({}),
  heartbeat_seconds: z.number().int().default(30),
  capabilities: z.array(z.enum(['jira-poll', 'jira-lookup', 'gh', 'merge-tree', 'rg', 'git-publish'])).default([]),
  state_file: z.string().optional(),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

export const CenterConfig = z.object({
  listen: z.string().default('0.0.0.0:7801'),
  database: z.string(),
  token: z.string(),
  panel_token: z.string(),
  proxy: z.string().optional(),
  ssh_bin: z.string().default('ssh'),
  feishu: z.object({
    app: z.string().optional(),
    owner_open_id: z.string().optional(),
    bot_open_id: z.string().optional(),
    intake_emoji: z.string().default('PUSHPIN'),
    approve_emoji: z.string().default('DONE'),
    reject_emoji: z.string().default('CrossMark'),
    daily_push_limit: z.number().int().default(30),
    lark_cli: z.string().default('lark-cli'),
    enabled: z.boolean().default(false),
  }).default({}),
  sources: z.object({
    feishu: z.object({
      enabled: z.boolean().default(false),
      /** 候选扫描开关与周期（S02 Step 18） */
      scan_enabled: z.boolean().default(false),
      scan_seconds: z.number().int().default(3600),
    }).default({}),
    jira: z.object({
      enabled: z.boolean().default(false),
      poll_seconds: z.number().int().default(300),
      jql: z.string().default('assignee = currentUser() AND resolution = Unresolved'),
      run_on_label: z.string().default('vpn:jira'),
      project_repo_map: z.record(z.string()).default({}),
    }).default({}),
  }).default({}),
  routing: z.record(z.object({ require: z.array(z.string()).default([]), prefer: z.string().optional() })).default({
    code: { require: ['build:doris'], prefer: 'dev' },
    analysis: { require: [], prefer: 'dev' },
    text: { require: [], prefer: 'center' },
  }),
  source_channels: z.record(z.string()).default({ jira: 'jira', feishu: 'feishu', cli: 'inbox', channel: 'inbox' }),
  /** 各仓库的基线分支（worktree.create 用），缺省 master */
  repo_base_branch: z.record(z.string()).default({ 'selectdb/selectdb-core': 'selectdb-cloud-4.0', 'apache/doris': 'master' }),
  agent_concurrency: z.record(z.number().int()).default({ claude: 3, codex: 3, opencode: 3 }),
  trust: z.object({
    threshold: z.number().int().default(5),
    locked_manual: z.array(z.string()).default(['merge_release', 'jira_done']),
  }).default({}),
  worktree: z.object({
    retain_days: z.number().int().default(3),
    disk_high_watermark: z.number().default(0.85),
  }).default({}),
  tunnels: z.record(z.object({ ssh: z.string(), remote_port: z.number().int().default(7801), local_port: z.number().int().default(7801) })).default({}),
  test_mode: z.boolean().default(false),
  smoke: z.object({ enabled: z.boolean().default(false), jiraKey: z.string().optional() }).default({}),
});
export type CenterConfig = z.infer<typeof CenterConfig>;

/** 把 ${ENV} 替换成环境变量值 */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? '');
}
