/**
 * A plain token bucket: an initial burst, then a steady lazy refill —
 * mechanism only, no policy. Time comes in through `take(now)` so the bucket
 * stays pure state (tests drive it with a fake clock, owners with
 * `Date.now()`).
 */
export interface TokenBucket {
  /** Spend one token if available. */
  take(now: number): boolean;
}

export function createTokenBucket(burst: number, refillMs: number): TokenBucket {
  let tokens = burst;
  // `null`, not a 0 sentinel: a legitimate `now` of 0 must anchor the refill
  // clock exactly once, not re-anchor on every call.
  let lastRefillAt: number | null = null;
  return {
    take(now) {
      lastRefillAt ??= now;
      const refilled = Math.floor((now - lastRefillAt) / refillMs);
      if (refilled > 0) {
        tokens = Math.min(burst, tokens + refilled);
        lastRefillAt += refilled * refillMs;
      }
      if (tokens <= 0) return false;
      tokens -= 1;
      return true;
    },
  };
}
