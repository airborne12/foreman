/**
 * 通知发送与重试队列（来源：S01 Step 27–31、EX-28.1/28.2；S05 Step 24；schema notifications）
 */
import type { Db } from '../db.js';
import type { Clock } from '../clock.js';
import type { FeishuAdapter } from '../adapters/feishu.js';
import type { CenterConfig } from '@foreman/shared';

export type NotificationKind = 'approval' | 'question' | 'intake_ack' | 'alert' | 'digest' | 'reply';

export class Notifications {
  constructor(private db: Db, private clock: Clock, private feishu: FeishuAdapter | null, private cfg: CenterConfig) {}

  /** 创建并立即尝试发送；失败进入重试（5 分钟，最多 3 次） */
  async send(n: { kind: NotificationKind; target: string; text: string; refType?: 'approval' | 'question' | 'task' | 'source' | null; refId?: string | null; replyTo?: string | null; defer?: boolean }): Promise<{ id: string; status: string; externalMessageId: string | null }> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO notifications (channel, kind, ref_type, ref_id, target, reply_to_message_id, text, status, created_at)
       VALUES ('feishu',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [n.kind, n.refType ?? null, n.refId ?? null, n.target, n.replyTo ?? null, n.text, n.defer ? 'deferred' : 'pending', this.clock.now()],
    );
    if (n.defer) return { id: row!.id, status: 'deferred', externalMessageId: null };
    return this.attempt(row!.id);
  }

  async attempt(id: string) {
    const n = await this.db.one<any>('SELECT * FROM notifications WHERE id=$1', [id]);
    if (!n) throw new Error('notification not found');
    if (!this.feishu) {
      await this.db.query(`UPDATE notifications SET status='failed', attempts=attempts+1, last_error='feishu disabled' WHERE id=$1`, [id]);
      return { id, status: 'failed', externalMessageId: null };
    }
    try {
      const r = n.reply_to_message_id ? await this.feishu.reply(n.reply_to_message_id, n.text) : await this.feishu.sendText(n.target, n.text);
      await this.db.query(`UPDATE notifications SET status='sent', attempts=attempts+1, external_message_id=$2, sent_at=$3, next_attempt_at=NULL WHERE id=$1`, [id, r.messageId, this.clock.now()]);
      return { id, status: 'sent', externalMessageId: r.messageId };
    } catch (e) {
      const attempts = Number(n.attempts) + 1;
      const final = attempts >= 3;
      const next = final ? null : new Date(this.clock.now().getTime() + 5 * 60_000);
      await this.db.query(`UPDATE notifications SET status='failed', attempts=$2, last_error=$3, next_attempt_at=$4 WHERE id=$1`, [id, attempts, String(e), next]);
      return { id, status: 'failed', externalMessageId: null };
    }
  }

  /** 调度器：重试到期的失败通知 */
  async retryDue() {
    const due = await this.db.query<{ id: string }>(`SELECT id FROM notifications WHERE status='failed' AND attempts < 3 AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1`, [this.clock.now()]);
    for (const r of due.rows) await this.attempt(r.id);
  }

  /** 当日已发送的审批推送数（S01 EX-28.2） */
  async sentTodayCount(kind: NotificationKind) {
    const now = this.clock.now();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const r = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE kind=$1 AND status='sent' AND sent_at >= $2`, [kind, start]);
    return Number(r?.n ?? 0);
  }

  /** 限频告警：同一 key 一小时内只发一次（S01 EX-6.1、S05 Step 24） */
  async alertOnce(key: string, text: string, refType: 'source' | 'task' | null = null) {
    const recent = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE kind='alert' AND text LIKE $1 AND created_at > $2`, [`%${key}%`, new Date(this.clock.now().getTime() - 3600_000)]);
    if (Number(recent?.n ?? 0) > 0) return null;
    const target = this.cfg.feishu.owner_open_id ?? 'owner';
    return this.send({ kind: 'alert', target, text: `[告警] ${text}`, refType });
  }
}
