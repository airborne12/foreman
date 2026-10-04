/** 任务树 API 编排：真实数据库、中心接口；所有数据位于独立测试库。 */
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { bootTestApp, http, type TestApp } from '../helpers/testApp.js';
import { seedTask, seedSession } from '../helpers/seed.js';
import { withReport } from '../helpers/reporter.js';

let app: TestApp;
beforeAll(async () => { app = await bootTestApp(); });
beforeEach(async () => { await http(app, 'POST', '/__test/reset'); });
afterAll(async () => { await app.close(); });
async function family(channel = 'jira') {
  const root = await seedTask(app.db, { key: 'T-86', channel, state: 'delivered' });
  await seedTask(app.db, { key: 'T-86.1', channel, parentKey: 'T-86', kind: 'pr', state: 'delivered' });
  const review = await seedTask(app.db, { key: 'T-86.2', channel, parentKey: 'T-86', kind: 'review', state: 'running' });
  return { root, review };
}
async function question(taskId: string) {
  const sessionId = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex' });
  await app.db.query("INSERT INTO questions (task_id,session_id,text,expires_at) VALUES ($1,$2,'请选择修复方案',now()+interval '1 hour')", [taskId, sessionId]);
}

describe('根任务与后续任务树', () => {
  it('ST-S03-29: 已交付父任务的运行中审查仍在进行中列表', () => withReport('ST-S03-29', async () => {
    await family();
    const r = await http(app, 'GET', '/api/channels/jira/threads?activeOnly=true');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items[0]).toMatchObject({ key: 'T-86', state: 'delivered', active: true, groupState: 'running', groupLabel: '审查中' });
    expect(r.body.items[0].children.map((t: any) => t.key)).toEqual(['T-86.1', 'T-86.2']);
    expect((await http(app, 'GET', '/api/channels/jira')).body.activeTasks).toBe(1);
  }));
  it('ST-S03-30: 打开深层子任务获得完整祖先与兄弟树', () => withReport('ST-S03-30', async () => {
    await family();
    await seedTask(app.db, { key: 'T-8601', parentKey: 'T-86.2', kind: 'code', state: 'queued' });
    const r = await http(app, 'GET', '/api/tasks/T-8601');
    expect(r.status).toBe(200);
    expect(r.body.parentKey).toBe('T-86.2');
    expect(r.body.taskTree.key).toBe('T-86');
    expect(r.body.taskTree.children.map((t: any) => t.key)).toEqual(['T-86.1', 'T-86.2']);
    expect(r.body.taskTree.children[1].children[0].key).toBe('T-8601');
  }));
  it('ST-S03-31: 后代状态筛选保留完整树，分页按根而非节点', () => withReport('ST-S03-31', async () => {
    await family();
    await seedTask(app.db, { key: 'T-87', state: 'running' });
    const first = await http(app, 'GET', '/api/channels/jira/threads?state=running&perPage=1&page=1');
    const second = await http(app, 'GET', '/api/channels/jira/threads?state=running&perPage=1&page=2');
    expect(first.body.total).toBe(2);
    expect(second.body.total).toBe(2);
    const items = [...first.body.items, ...second.body.items];
    expect(items.map((t: any) => t.key).sort()).toEqual(['T-86', 'T-87']);
    expect(items.find((t: any) => t.key === 'T-86').children).toHaveLength(2);
  }));
  it('ST-S03-32: 后代最近活动决定根任务排序，子任务号自然排序', () => withReport('ST-S03-32', async () => {
    const { review } = await family();
    await seedTask(app.db, { key: 'T-87', state: 'running' });
    await seedTask(app.db, { key: 'T-86.10', parentKey: 'T-86', kind: 'pr', state: 'delivered' });
    await app.db.query("UPDATE tasks SET created_at='2099-09-01T00:00:00Z',last_activity_at='2099-09-01T00:00:00Z',updated_at='2099-09-01T00:00:00Z'");
    await app.db.query("UPDATE tasks SET last_activity_at='2099-09-03T00:00:00Z',updated_at='2099-09-03T00:00:00Z' WHERE id=$1", [review]);
    const r = await http(app, 'GET', '/api/channels/jira/threads');
    expect(r.body.items[0].key).toBe('T-86');
    expect(r.body.items[0].latestActivityAt).toBe('2099-09-03T00:00:00.000Z');
    expect(r.body.items[0].children.map((t: any) => t.key)).toEqual(['T-86.1', 'T-86.2', 'T-86.10']);
  }));
  it('ST-S03-33: 跨层待办同归一个根任务，频道和事项总数正确', () => withReport('ST-S03-33', async () => {
    const { review } = await family('doris-index');
    const nested = await seedTask(app.db, { key: 'T-8601', channel: 'doris-index', parentKey: 'T-86.2', state: 'failed' });
    await question(review);
    await app.db.query("INSERT INTO approvals (key,task_id,action_type,title,body,body_hash,trust_mode_snapshot) VALUES ('A-901',$1,'create_pr','创建修复 PR','正文','hash','manual')", [nested]);
    const r = await http(app, 'GET', '/api/inbox');
    expect(r.body.counts.actionable).toBe(3);
    for (const it of [...r.body.approvals, ...r.body.questions, ...r.body.failures]) expect(it.rootTask).toMatchObject({ key: 'T-86', channel: 'doris-index' });
    expect(r.body.questions[0].channel).toBe('doris-index');
    const tree = (await http(app, 'GET', '/api/tasks/T-86')).body.taskTree;
    expect(tree.attentionCount).toBe(3);
    expect(tree.groupState).toBe('waiting_input');
  }));
  it('ST-S03-34: 待办处理完与审查结束后恢复已交付汇总，保留任务自身状态', () => withReport('ST-S03-34', async () => {
    const { review } = await family();
    await question(review);
    await app.db.query("UPDATE tasks SET state='done' WHERE id=$1", [review]);
    expect((await http(app, 'GET', '/api/tasks/T-86')).body.taskTree.active).toBe(true);
    await app.db.query("UPDATE questions SET status='answered',answer='方案一'");
    const root = (await http(app, 'GET', '/api/tasks/T-86')).body;
    expect(root.state).toBe('delivered');
    expect(root.taskTree).toMatchObject({ active: false, attentionCount: 0, groupState: 'delivered' });
    expect((await http(app, 'GET', '/api/channels/jira/threads?activeOnly=true')).body.total).toBe(0);
    expect((await http(app, 'GET', '/api/channels/jira/threads')).body.total).toBe(1);
  }));
  it('ST-S03-35: 累计分页窗口在后代活动改变排序后仍唯一且完整', () => withReport('ST-S03-35', async () => {
    await family();
    await seedTask(app.db, { key: 'T-87', state: 'running' });
    const latest = await seedTask(app.db, { key: 'T-88', state: 'running' });
    const before = await http(app, 'GET', '/api/channels/jira/threads?perPage=1&throughPage=2');
    expect(before.body.items).toHaveLength(2);
    await app.db.query("UPDATE tasks SET last_activity_at='2099-10-04T00:00:00Z' WHERE id=$1", [latest]);
    const after = await http(app, 'GET', '/api/channels/jira/threads?perPage=1&throughPage=3');
    expect(after.body.items.map((t: any) => t.key).sort()).toEqual(['T-86', 'T-87', 'T-88']);
    expect(after.body.items[0].key).toBe('T-88');
    expect(after.body.total).toBe(3);
  }));
  it('ST-S03-36: 搜索深层子任务保留祖先并隔离其他频道', () => withReport('ST-S03-36', async () => {
    await family();
    await seedTask(app.db, { key: 'T-8601', parentKey: 'T-86.2', state: 'queued' });
    await seedTask(app.db, { key: 'T-87', channel: 'other-channel', state: 'running' });
    await app.db.query("UPDATE tasks SET title='Followup marker' WHERE key IN ('T-8601','T-87')");
    const r = await http(app, 'GET', '/api/channels/jira/threads?search=FOLLOWUP');
    expect(r.body.total).toBe(1);
    expect(r.body.items[0].key).toBe('T-86');
    expect(r.body.items[0].children[1].children[0].key).toBe('T-8601');
    expect((await http(app, 'GET', '/api/channels/jira/threads?search=missing')).body.items).toEqual([]);
  }));
  it('ST-S03-37: 已完成节点的待审批和可重试失败审批仍影响整体状态', () => withReport('ST-S03-37', async () => {
    const { review } = await family();
    await app.db.query("UPDATE tasks SET state='done' WHERE id=$1", [review]);
    await app.db.query("INSERT INTO approvals (key,task_id,action_type,title,body,body_hash,trust_mode_snapshot) VALUES ('A-902',$1,'create_pr','审批','正文','hash','manual')", [review]);
    expect((await http(app, 'GET', '/api/tasks/T-86')).body.taskTree).toMatchObject({ active: true, attentionCount: 1, groupState: 'waiting_approval' });
    await app.db.query("UPDATE approvals SET status='failed',payload='{\"retryable\":true}' WHERE key='A-902'");
    expect((await http(app, 'GET', '/api/tasks/T-86')).body.taskTree).toMatchObject({ active: true, attentionCount: 1, groupState: 'failed' });
    expect((await http(app, 'GET', '/api/channels/jira/threads?activeOnly=true')).body.total).toBe(1);
  }));
});
