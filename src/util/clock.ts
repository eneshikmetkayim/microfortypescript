/** Injectable clock so SIP timers are deterministic in tests. */

export interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  now(): number;
}

export const systemTimers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    // Timers must not keep the CLI/web process alive on their own.
    if (typeof handle === "object" && handle && "unref" in handle) {
      (handle as { unref(): void }).unref();
    }
    return handle as unknown as number;
  },
  clearTimeout(handle) {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
  now() {
    return Date.now();
  },
};

interface Scheduled {
  at: number;
  fn: () => void;
  id: number;
  cancelled: boolean;
}

export class FakeTimers implements Timers {
  private current = 0;
  private nextId = 1;
  private queue: Scheduled[] = [];

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.queue.push({ at: this.current + Math.max(0, ms), fn, id, cancelled: false });
    return id;
  }

  clearTimeout(handle: number): void {
    const item = this.queue.find((s) => s.id === handle);
    if (item) item.cancelled = true;
    this.queue = this.queue.filter((s) => !s.cancelled);
  }

  now(): number {
    return this.current;
  }

  /** Advance the virtual clock, running due callbacks in time order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.queue
        .filter((s) => !s.cancelled && s.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((s) => s !== due);
      this.current = due.at;
      due.fn();
    }
    this.current = target;
  }

  get pending(): number {
    return this.queue.filter((s) => !s.cancelled).length;
  }
}
