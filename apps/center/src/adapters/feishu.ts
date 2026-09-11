/**
 * 飞书适配器（机器人身份）。真实实现通过 lark-cli 子进程；测试用 FakeFeishu。
 * 来源：core-04-conversation-design.md §2；architecture 2.3；S02 Step 7–14、Step 19–22
 */
import { spawn } from 'node:child_process';

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatName?: string | null;
  senderOpenId: string;
  senderName?: string | null;
  text: string;
  createdAt: string;
}

/** S02 Step 10：原消息 + 前后文 + 群名 + 发送者 */
export interface FeishuContext {
  message: FeishuMessage;
  context: FeishuMessage[];
  chatName: string;
  sender: string;
}

export interface FeishuAdapter {
  sendText(target: string, text: string): Promise<{ messageId: string }>;
  reply(messageId: string, text: string): Promise<{ messageId: string }>;
  /** S02 Step 7–10：读原消息与前后各 N 条 */
  fetchContext(input: { chatId?: string | null; messageId: string; before: number; after: number }): Promise<FeishuContext>;
  /** S02 Step 19–22：读增量消息（已过滤机器人自己的消息） */
  fetchRecent(input: { since?: string | null; limit?: number }): Promise<FeishuMessage[]>;
}

export class LarkCliFeishu implements FeishuAdapter {
  constructor(private bin: string, private botOpenId?: string | null) {}
  private run(args: string[]): Promise<string> {
    return new Promise((res, rej) => {
      const p = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
      p.on('error', rej);
      p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`lark-cli exit ${code}: ${err || out}`))));
    });
  }
  async sendText(target: string, text: string) {
    const out = await this.run(['im', '+messages-send', '--user-id', target, '--text', text, '--as', 'bot', '--json']);
    return { messageId: parseMessageId(out) };
  }
  async reply(messageId: string, text: string) {
    const out = await this.run(['im', '+messages-reply', '--message-id', messageId, '--text', text, '--as', 'bot', '--json']);
    return { messageId: parseMessageId(out) };
  }
  async fetchContext(input: { chatId?: string | null; messageId: string; before: number; after: number }): Promise<FeishuContext> {
    const one = parseMessages(await this.run(['im', '+messages-get', '--message-id', input.messageId, '--as', 'bot', '--json']))[0];
    if (!one) throw new Error(`消息 ${input.messageId} 不存在或无权读取`);
    const chatId = input.chatId ?? one.chatId;
    const all = parseMessages(await this.run(['im', '+messages-list', '--chat-id', chatId, '--as', 'bot', '--json']));
    const idx = all.findIndex((m) => m.messageId === input.messageId);
    const context = idx < 0 ? [one] : all.slice(Math.max(0, idx - input.before), idx + input.after + 1);
    return { message: { ...one, chatId }, context, chatName: one.chatName ?? chatId, sender: one.senderOpenId };
  }
  async fetchRecent(input: { since?: string | null; limit?: number }): Promise<FeishuMessage[]> {
    const args = ['im', '+messages-list', '--as', 'bot', '--json'];
    if (input.since) args.push('--start-time', input.since);
    const all = parseMessages(await this.run(args));
    return all.filter((m) => m.senderOpenId !== this.botOpenId).slice(-(input.limit ?? 50));
  }
}

function parseMessageId(out: string): string {
  try { const j = JSON.parse(out); return j.message_id ?? j.data?.message_id ?? String(j.id ?? ''); } catch { return out.trim(); }
}

function parseMessages(out: string): FeishuMessage[] {
  let j: any; try { j = JSON.parse(out); } catch { return []; }
  const rows: any[] = Array.isArray(j) ? j : j.items ?? j.data?.items ?? (j.message_id ? [j] : []);
  return rows.map((m) => ({
    messageId: m.message_id ?? m.messageId ?? '',
    chatId: m.chat_id ?? m.chatId ?? '',
    chatName: m.chat_name ?? m.chatName ?? null,
    senderOpenId: m.sender?.id ?? m.sender_open_id ?? m.senderOpenId ?? '',
    senderName: m.sender?.name ?? null,
    text: typeof m.body?.content === 'string' ? safeText(m.body.content) : (m.text ?? ''),
    createdAt: m.create_time ?? m.createdAt ?? new Date().toISOString(),
  }));
}
function safeText(content: string) { try { const c = JSON.parse(content); return c.text ?? content; } catch { return content; } }

/** 测试用：记录所有发送，可注入失败与消息库 */
export class FakeFeishu implements FeishuAdapter {
  sent: Array<{ kind: 'messages-send' | 'messages-reply'; target?: string; message_id?: string; text: string; id: string; at: number }> = [];
  failSend = false;
  failReply = false;
  /** S02 EX-8.1：messages-get 首次失败 */
  failGetOnce = false;
  failGet = false;
  botOpenId = 'ou_bot';
  chats: Record<string, { name: string; messages: FeishuMessage[] }> = {};
  recent: FeishuMessage[] = [];
  private n = 0;

  reset() {
    this.sent = []; this.failSend = false; this.failReply = false; this.failGetOnce = false; this.failGet = false;
    this.chats = {}; this.recent = []; this.n = 0;
  }

  async sendText(target: string, text: string) {
    if (this.failSend) throw new Error('fake lark-cli: send failed');
    const id = `om_fake_${++this.n}`;
    this.sent.push({ kind: 'messages-send', target, text, id, at: Date.now() });
    return { messageId: id };
  }
  async reply(messageId: string, text: string) {
    if (this.failReply) throw new Error('fake lark-cli: reply failed');
    const id = `om_fake_${++this.n}`;
    this.sent.push({ kind: 'messages-reply', message_id: messageId, text, id, at: Date.now() });
    return { messageId: id };
  }
  find(messageId: string): { chatId: string; chat: { name: string; messages: FeishuMessage[] }; index: number } | null {
    for (const [chatId, chat] of Object.entries(this.chats)) {
      const i = chat.messages.findIndex((m) => m.messageId === messageId);
      if (i >= 0) return { chatId, chat, index: i };
    }
    return null;
  }
  async fetchContext(input: { chatId?: string | null; messageId: string; before: number; after: number }): Promise<FeishuContext> {
    if (this.failGetOnce) { this.failGetOnce = false; throw new Error('fake lark-cli: messages-get failed'); }
    if (this.failGet) throw new Error('fake lark-cli: messages-get failed');
    const hit = this.find(input.messageId);
    if (!hit) throw new Error(`fake lark-cli: 消息 ${input.messageId} 不存在`);
    const { chat, index } = hit;
    const context = chat.messages.slice(Math.max(0, index - input.before), index + input.after + 1);
    const message = chat.messages[index]!;
    return { message, context, chatName: chat.name, sender: message.senderOpenId };
  }
  async fetchRecent(input: { since?: string | null; limit?: number }): Promise<FeishuMessage[]> {
    if (this.failGet) throw new Error('fake lark-cli: messages-list failed');
    const since = input.since ? new Date(input.since).getTime() : 0;
    return this.recent.filter((m) => m.senderOpenId !== this.botOpenId && new Date(m.createdAt).getTime() >= since).slice(0, input.limit ?? 50);
  }
}
