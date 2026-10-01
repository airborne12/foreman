/** 面板 API 客户端：panelToken 存 localStorage，401 时回到 token 门 */
const TOKEN_KEY = 'foreman.panelToken';
/** 仅开发期：实验环境起 Vite 时注入的一次性 token，免得每次手输；生产构建不设这个变量，恒为空 */
const DEV_TOKEN = (import.meta.env.VITE_PANEL_TOKEN as string | undefined) ?? '';
/** 浏览器存储在隐私模式下可能读写失败，一律吞掉，面板照常工作 */
export const prefs = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
};
export const getToken = () => prefs.get(TOKEN_KEY) ?? DEV_TOKEN;
export const setToken = (t: string) => prefs.set(TOKEN_KEY, t.trim());
export const clearToken = () => prefs.del(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '连不上中心服务');
  }
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new ApiError(r.status, body?.code ?? 'HTTP_' + r.status, body?.message ?? text.slice(0, 200), body?.details);
  return body as T;
}

/** 错误码 → 人话（core-02 §5.1 #9）：不把 zod 原文、英文枚举直接甩给用户 */
const ERROR_TEXT: Record<string, string> = {
  NETWORK: '连不上中心服务，稍后会自动重试',
  VALIDATION_FAILED: '提交的内容格式不对',
  APPROVAL_ALREADY_DECIDED: '这项已经在别处处理过了',
  APPROVAL_BODY_CHANGED: '内容已经更新，请看最新版本再决定',
  APPROVAL_NOT_PENDING: '这项已经不在待处理状态',
  QUESTION_ALREADY_ANSWERED: '这个问题已经在别处回答过了',
  DRAFT_NOT_OPEN: '草案已经确认、取消或过期',
  RUNTIME_OFFLINE: '目标 runtime 不在线',
  AUTH_INVALID: '登录已失效，请重新输入 token',
  INTERNAL: '中心服务出错了',
};
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    // 业务错误的 message 本身就是给人看的中文；只有格式校验和兜底错误才换成固定说法
    if (e.code === 'VALIDATION_FAILED') return ERROR_TEXT.VALIDATION_FAILED!;
    if (e.code === 'NETWORK' || e.code === 'INTERNAL' || e.code.startsWith('HTTP_5')) return ERROR_TEXT[e.code] ?? '中心服务出错了';
    return /[一-龥]/.test(e.message) ? e.message : (ERROR_TEXT[e.code] ?? e.message);
  }
  const m = String((e as Error)?.message ?? e);
  return /fetch failed|Failed to fetch|NetworkError/i.test(m) ? ERROR_TEXT.NETWORK! : m;
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
/** 相对时间（§四：hover 看绝对时间） */
export function relTime(iso?: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} 天前`;
  return fmtTime(iso);
}

export const STATE_LABEL: Record<string, string> = {
  draft: '草稿', triaging: '分流中', pending_decision: '待拍板', queued: '排队中', running: '运行中',
  waiting_input: '等待输入', waiting_approval: '等待审批', failed: '失败', delivered: '已交付', done: '已完成', paused: '已暂停',
};
export const STATE_TONE: Record<string, string> = {
  triaging: 'info', pending_decision: 'warn', queued: '', running: 'accent', waiting_input: 'warn', waiting_approval: 'warn',
  failed: 'bad', delivered: 'go', done: 'go', paused: '', draft: '',
};
export const SESSION_STATE_LABEL: Record<string, string> = { planned: '准备中', running: '运行中', waiting_input: '等待输入', done: '已结束', failed: '失败', stopped: '已停止', lost: '失联' };
export const SESSION_KIND_LABEL: Record<string, string> = { code_locate: '代码定位', implement: '实现', plan: '出方案', proto: '出原型', review: 'review', dispatcher: '调度员' };
export const PATH_LABEL: Record<string, string> = { fix: '简单修复', plan: '出方案', proto: '出原型' };
export const EFFORT_LABEL: Record<string, string> = { small: '小（<2h）', medium: '中（半天）', large: '大（>1 天）' };
export const ACTION_LABEL: Record<string, string> = {
  triage_confirm: '分流卡确认', start_implement: '按方案实现', create_pr: '创建 PR', start_pick: '开始 pick',
  resolve_conflict_push: '解冲突并推送', reply_review: '回复 review', rerun_ci: '重跑 CI', merge_master: '合入 master',
  merge_release: '合入 release', jira_transition_in_progress: 'Jira 转进行中', jira_done: 'Jira 转完成',
  feishu_reply: '飞书回帖', jira_comment: 'Jira 评论',
};
export const RETRY_LABEL: Record<string, string> = { retry: '重试', same_agent: '重试', switch_agent: '开新 Codex 会话', fresh_session: '开新会话继续', abandon: '放弃' };

/** Jira 优先级归一成 0–3（P0 最急）；认不出的返回 null */
export function prioRank(p?: string | null): number | null {
  if (!p) return null;
  const s = p.trim().toLowerCase();
  const m = /^p\s*([0-4])$/.exec(s); if (m) return Math.min(3, Number(m[1]));
  if (['highest', 'blocker', '紧急', '最高'].includes(s)) return 0;
  if (['high', 'critical', '高'].includes(s)) return 1;
  if (['medium', 'major', 'normal', '中'].includes(s)) return 2;
  if (['low', 'lowest', 'minor', 'trivial', '低', '最低'].includes(s)) return 3;
  return null;
}

/** 标题去掉开头重复的来源单号（Jira 入库的任务标题是「KEY · 摘要」，§5.1 #3） */
export function cleanTitle(title?: string | null, ref?: string | null): string {
  const t = title ?? '';
  if (ref && t.startsWith(ref)) return t.slice(ref.length).replace(/^\s*[·:：-]\s*/, '') || t;
  return t.replace(/^T-\d+\s*·\s*/, '');
}

/** 系统事件转人话（§5.1 #8）：路由调试串、动作类型英文名 */
export function humanize(text: string): string {
  let t = text;
  const route = /^routing: \w+ → (?:require [^→]+ → )?(?:prefer|会话最少) (\S+)(.*)$/.exec(t);
  if (route) t = `派到 ${route[1]}${route[2] ?? ''}`;
  t = t.replace(/^routing: \w+ →\s*(?:require ([^→]+) →\s*)?无在线候选/, (_m, req) => `没有在线的 runtime${req ? `（需要 ${String(req).trim()}）` : ''}`);
  t = t.replace(/^routing: \w+ → 在线 runtime 都没有登记仓库/, '在线 runtime 都没有登记仓库');
  t = t.replace(/^手动覆盖 runtime=(\S+)/, '手动指定 $1');
  t = t.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (m) => ACTION_LABEL[m] ?? m);
  return t;
}
