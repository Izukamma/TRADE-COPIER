/**
 * Sliding-window limiter. `acquire` waits (bounded) until a slot is free instead of
 * letting the platform reject the request.
 */
export class SlidingWindowLimiter {
  private stamps: number[] = [];
  constructor(
    public readonly name: string,
    public limit: number,
    public windowMs: number,
  ) {}

  used(now = Date.now()): number {
    this.prune(now);
    return this.stamps.length;
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.stamps.length && this.stamps[0]! <= cutoff) this.stamps.shift();
  }

  /** Milliseconds until a slot is available (0 = now). */
  waitTime(now = Date.now()): number {
    this.prune(now);
    if (this.stamps.length < this.limit) return 0;
    return this.stamps[0]! + this.windowMs - now + 1;
  }

  async acquire(maxWaitMs = 10_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const w = this.waitTime();
      if (w === 0) {
        this.stamps.push(Date.now());
        return;
      }
      if (Date.now() + w > deadline) throw new RateLimitWaitExceeded(this.name, w);
      await sleep(w);
    }
  }
}

export class RateLimitWaitExceeded extends Error {
  constructor(
    public limiter: string,
    public waitMs: number,
  ) {
    super(`rate limit ${limiter}: next slot in ${waitMs}ms exceeds allowed wait`);
  }
}
