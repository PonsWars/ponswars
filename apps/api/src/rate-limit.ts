/**
 * How often one caller may ask (§59.3).
 *
 * §5 makes spectating the normal case and most of this API is a read, but two
 * routes are not: `POST /v1/auth/challenge` writes a row, and
 * `POST /v1/auth/verify` recovers a public key from a signature. Recovery is
 * arithmetic, and `docs/operations/load-testing.md` measures it at 281 a
 * second on one core — the only request in this service whose cost is CPU
 * rather than IO, and the one an anonymous caller can ask for without ever
 * proving anything. A few hundred requests a second from one machine is enough
 * to hold every core, and the round driver shares them (§21.3).
 *
 * So the limit exists to keep one caller from spending everybody's CPU. It is
 * not a security boundary: an attacker with a thousand addresses is an edge
 * problem, and nothing here pretends otherwise.
 *
 * The rule is a token bucket rather than a counter per calendar window. A
 * counter lets a caller spend the whole allowance in the last instant of one
 * window and the whole of the next in the first — twice the limit back to back,
 * which is exactly the burst the limit exists to stop. A bucket refills
 * smoothly, so the sustained rate is the rate configured and a quiet caller
 * still gets a full burst when they arrive.
 */

export interface RateLimitRule {
  /** Requests allowed in a window, and the most that may arrive at once. */
  readonly limit: number;
  /** How long refilling the whole bucket takes. */
  readonly windowMs: number;
}

/**
 * Charges one request against `key`.
 *
 * Returns how long the caller must wait, in milliseconds; `0` means the request
 * may proceed and a token was spent. A function rather than an interface so the
 * Redis-backed implementation in `@ponswars/redis` satisfies it without either
 * package having to depend on the other.
 */
export type RateLimit = (key: string, rule: RateLimitRule) => Promise<number>;

interface Bucket {
  tokens: number;
  at: number;
}

/** How many calls between sweeps of buckets nobody has touched since. */
const SWEEP_EVERY = 1_000;

/**
 * A limiter for one process (§21.3).
 *
 * What the local stack and the tests run. A deployment behind more than one
 * instance wants the Redis one instead: n instances with a limiter each let a
 * caller through n times the rule, and which instance a request lands on is the
 * load balancer's business rather than anything this can see.
 */
export function memoryRateLimit(now: () => number = Date.now): RateLimit {
  const buckets = new Map<string, Bucket>();
  let sinceSweep = 0;

  return (key, rule) => {
    const at = now();
    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      for (const [id, bucket] of buckets) {
        // A bucket that has had a whole window to refill is full, and a full
        // bucket is indistinguishable from one that never existed.
        if (at - bucket.at >= rule.windowMs) {
          buckets.delete(id);
        }
      }
    }

    const bucket = buckets.get(key) ?? { tokens: rule.limit, at };
    const waitMs = spend(bucket, rule, at);
    buckets.set(key, bucket);
    return Promise.resolve(waitMs);
  };
}

/**
 * Refills a bucket up to `at` and takes a token if there is one.
 *
 * Time only ever moves forward here. Two instances do not share a clock, and
 * one running behind would otherwise hand back tokens the bucket never had.
 */
function spend(bucket: Bucket, rule: RateLimitRule, at: number): number {
  const elapsed = at - bucket.at;
  if (elapsed > 0) {
    bucket.tokens = Math.min(rule.limit, bucket.tokens + (elapsed * rule.limit) / rule.windowMs);
    bucket.at = at;
  }
  if (bucket.tokens < 1) {
    return Math.ceil(((1 - bucket.tokens) * rule.windowMs) / rule.limit);
  }
  bucket.tokens -= 1;
  return 0;
}
