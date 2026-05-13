/** In-process per-user token bucket for chat message posts.
 *
 *  Per user (keyed by email): 5-token capacity, refills at 1 token / sec,
 *  hard cap of 50 messages / minute (enforced as a separate sliding window).
 *  Process-local — a multi-worker cluster gets `effective_limit * worker_count`,
 *  which is still well under abuse thresholds at launch traffic.
 *
 *  Returns either `{ ok: true }` or `{ ok: false, retryAfterMs }`. Callers
 *  surface the retry value in the 429 response's `Retry-After` header. */

interface Bucket {
  tokens: number;
  refillAt: number;          // ms — last time tokens were recomputed
  windowStart: number;       // ms — start of current 60s window
  windowCount: number;       // posts in current 60s window
}

const BUCKET_CAPACITY = 5;
const REFILL_PER_SEC = 1;
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 50;

const buckets = new Map<string, Bucket>();

export function allowPost(userKey: string, now: number = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
  let b = buckets.get(userKey);
  if (!b) {
    b = { tokens: BUCKET_CAPACITY, refillAt: now, windowStart: now, windowCount: 0 };
    buckets.set(userKey, b);
  }

  // Refill: tokens += elapsed_seconds * REFILL_PER_SEC, capped at capacity.
  const elapsedSec = (now - b.refillAt) / 1000;
  if (elapsedSec > 0) {
    b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + elapsedSec * REFILL_PER_SEC);
    b.refillAt = now;
  }

  // Reset the 60s window if it elapsed.
  if (now - b.windowStart >= WINDOW_MS) {
    b.windowStart = now;
    b.windowCount = 0;
  }

  if (b.windowCount >= WINDOW_LIMIT) {
    const retryAfterMs = WINDOW_MS - (now - b.windowStart);
    return { ok: false, retryAfterMs };
  }
  if (b.tokens < 1) {
    // ms until next token: (1 - tokens) seconds.
    const retryAfterMs = Math.ceil((1 - b.tokens) * 1000);
    return { ok: false, retryAfterMs };
  }

  b.tokens -= 1;
  b.windowCount += 1;
  return { ok: true };
}

/** Test-only: clear all buckets. */
export function _resetForTests() {
  buckets.clear();
}
