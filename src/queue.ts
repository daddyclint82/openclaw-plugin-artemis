/** Bounded admission for child tool calls: FIFO with explicit overflow,
 * queue timeout, and AbortSignal support. No jumping the queue. */

export class QueueOverflowError extends Error {
  constructor(maxWaiting: number) {
    super(`admission queue full (${maxWaiting} waiting)`);
    this.name = "QueueOverflowError";
  }
}
export class QueueTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`queued request waited over ${waitedMs}ms for a slot`);
    this.name = "QueueTimeoutError";
  }
}
export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

interface Waiter {
  grant: () => void;
  reject: (err: Error) => void;
  done: Promise<void>;
  settled: boolean;
}

export class BoundedSemaphore {
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(
    /** Max requests allowed to WAIT (not counting the running one). */
    private readonly maxWaiting: number,
    private readonly concurrency = 1,
  ) {}

  get waitingCount(): number {
    return this.waiters.length;
  }

  get activeCount(): number {
    return this.active;
  }

  /**
   * Acquire a slot. Rejects immediately with QueueOverflowError when the
   * waiting queue is full, QueueTimeoutError after waitTimeoutMs of waiting,
   * or CancelledError when the signal aborts while queued. Fair FIFO:
   * a new request never jumps queued waiters.
   */
  async acquire(waitTimeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new CancelledError("cancelled before admission");

    const fastPath = this.active < this.concurrency && this.waiters.length === 0;
    if (!fastPath && this.waiters.length >= this.maxWaiting)
      throw new QueueOverflowError(this.maxWaiting);
    if (fastPath) {
      this.active++;
      return this.makeReleaser();
    }

    const waiter = {} as Waiter;
    waiter.done = new Promise<void>((resolve, reject) => {
      waiter.grant = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        resolve();
      };
      waiter.reject = (err: Error) => {
        if (waiter.settled) return;
        waiter.settled = true;
        reject(err);
      };
    });
    this.waiters.push(waiter);

    const timer = setTimeout(() => waiter.reject(new QueueTimeoutError(waitTimeoutMs)), waitTimeoutMs);
    const abortListener = () => waiter.reject(new CancelledError("cancelled while queued"));
    signal?.addEventListener("abort", abortListener, { once: true });

    try {
      await waiter.done;
    } catch (err) {
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) this.waiters.splice(idx, 1);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
    }

    this.active++;
    return this.makeReleaser();
  }

  private makeReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next.grant();
    };
  }
}