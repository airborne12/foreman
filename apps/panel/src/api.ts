/** 面板 API 客户端：panelToken 存 localStorage，401 时回到 token 门 */
const TOKEN_KEY = 'foreman.panelToken';
/** 仅开发期：实验环境起 Vite 时注入的一次性 token，免得每次手输；生产构建不设这个变量，恒为空 */
const DEV_TOKEN = (import.meta.env.VITE_PANEL_TOKEN as string | undefined) ?? '';
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? DEV_TOKEN;
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t.trim());
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new ApiError(r.status, body?.code ?? 'HTTP_' + r.status, body?.message ?? text.slice(0, 200), body?.details);
  return body as T;
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
export const STATE_LABEL: Record<string, string> = {
  draft: '草稿', triaging: '分流中', pending_decision: '待拍板', queued: '排队中', running: '运行中',
  waiting_input: '等待输入', waiting_approval: '等待审批', failed: '失败', delivered: '已交付', done: '已完成', paused: '已暂停',
};
export const PATH_LABEL: Record<string, string> = { fix: '简单修复', plan: '出方案', proto: '出原型' };
export const ACTION_LABEL: Record<string, string> = {
  triage_confirm: '分流卡确认', start_implement: '按方案实现', create_pr: '创建 PR', start_pick: '开始 pick',
  resolve_conflict_push: '解冲突并推送', reply_review: '回复 review', rerun_ci: '重跑 CI', merge_master: '合入 master',
  merge_release: '合入 release', jira_transition_in_progress: 'Jira 转进行中', jira_done: 'Jira 转完成',
  feishu_reply: '飞书回帖', jira_comment: 'Jira 评论',
};
