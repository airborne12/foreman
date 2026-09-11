/** 全局错误码目录（来源：api/approvals.yaml x-error-codes；worker-channel.yaml ErrorMessage.code） */
export const ERROR_CODES = {
  UNAUTHORIZED: '未认证',
  NOT_FOUND: '资源不存在',
  VALIDATION_FAILED: '请求校验失败',
  CHANNEL_NOT_FOUND: '频道不存在',
  CHANNEL_EXISTS: '频道已存在',
  APPROVAL_ALREADY_DECIDED: '审批已被另一通道处理',
  APPROVAL_BODY_CHANGED: '正文已变更，原审批作废',
  APPROVAL_NOT_PENDING: '审批不在 pending 状态',
  REPO_REQUIRED: '请先选择目标仓库',
  DRAFT_NOT_OPEN: '草案已取消或过期',
  TASK_NOT_FAILED: '任务不在 failed 状态',
  NO_PLAN_ARTIFACT: '任务没有方案类产物',
  QUESTION_ALREADY_ANSWERED: '问题已被另一通道回答',
  RUNTIME_OFFLINE: 'runtime 离线',
  RUNTIME_NAME_CONFLICT: 'runtime 名冲突',
  AUTH_INVALID: 'token 无效',
  VERSION_UNSUPPORTED: 'worker 版本不兼容',
  TRUST_LOCKED: '动作类型锁定人工',
  ACTION_NOT_REVOCABLE: '动作已不可回滚',
  SOURCE_UNAVAILABLE: '来源系统不可达',
  CANDIDATE_NOT_OPEN: '候选已处理',
  WORKTREE_FAILED: 'worktree 操作失败',
  AGENT_START_FAILED: 'agent 启动失败',
  RESUME_FAILED: '会话续接失败',
  UNKNOWN_COMMAND: '未知指令',
  FORBIDDEN_ENV: '禁止的环境变量',
  INTERNAL: '内部错误',
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_CODES[code]);
  }
  toBody() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}
