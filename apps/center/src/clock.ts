/**
 * 可注入时钟。所有超时、离线判定、调度都从这里取时间，测试用 FakeClock 推进。
 */
export interface Clock {
  now(): Date;
  /** 注册一次性定时器，返回取消函数；fn 返回 Promise 时 FakeClock.advance 会等待它完成 */
  after(ms: number, fn: () => void | Promise<unknown>): () => void;
  /** 注册周期定时器，返回取消函数 */
  every(ms: number, fn: () => void | Promise<unknown>): () => void;
}

export class SystemClock implements Clock {
  now() { return new Date(); }
  after(ms: number, fn: () => void | Promise<unknown>) {
    const t = setTimeout(() => { void fn(); }, ms);
    return () => clearTimeout(t);
  }
  every(ms: number, fn: () => void | Promise<unknown>) {
    const t = setInterval(() => { void fn(); }, ms);
    return () => clearInterval(t);
  }
}

interface Timer { id: number; at: number; fn: () => void | Promise<unknown>; interval?: number }

export class FakeClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  private seq = 0;
  constructor(start: Date = new Date('2026-09-10T08:00:00Z')) { this.t = start.getTime(); }
  now() { return new Date(this.t); }
  /** 冻结到某一时刻：已登记的定时器整体平移，保持相对时序（测试 reset 回拨时钟时周期作业仍按间隔触发） */
  freeze(at?: Date) { if (at) { const delta = at.getTime() - this.t; this.t = at.getTime(); for (const x of this.timers) x.at += delta; } }
  after(ms: number, fn: () => void | Promise<unknown>) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  }
  every(ms: number, fn: () => void | Promise<unknown>) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn, interval: ms });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  }
  /** 推进时间，按到期顺序触发定时器（异步 fn 依次 await） */
  async advance(ms: number) {
    const target = this.t + ms;
    // 大跨度推进（如 7 天）时周期作业不必逐次触发：每个周期定时器最多触发 MAX_FIRINGS 次，之后跳到最后一个周期边界
    const fired = new Map<number, number>();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.interval) {
        const n = (fired.get(due.id) ?? 0) + 1; fired.set(due.id, n);
        due.at += due.interval;
        if (n >= FakeClock.MAX_FIRINGS && due.at <= target) { const remaining = Math.floor((target - due.at) / due.interval); due.at += remaining * due.interval; }
      } else this.timers = this.timers.filter((x) => x.id !== due.id);
      await due.fn();
    }
    this.t = target;
  }
  static MAX_FIRINGS = 130;
}
