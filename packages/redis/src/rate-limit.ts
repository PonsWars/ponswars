import { createClient, type RedisClientType } from 'redis';

/**
 * One rate limit across every instance (§21.3, §59.3).
 *
 * The rule a deployment configures is a rate for the service, not a rate per
 * process: three instances each keeping their own count would let a caller
 * through three times the number that was chosen, and which instance a request
 * lands on is the load balancer's business rather than anything the API can
 * see. So the buckets live where the other cross-instance state lives.
 *
 * The bucket is refilled and spent inside one Lua script, because the read and
 * the write have to be one operation: two instances that read the same bucket
 * before either wrote would both be told there was a token, and the limit would
 * be whatever the concurrency happened to be.
 *
 * **It fails open.** Redis unreachable means requests are allowed and the
 * problem is reported. The limiter protects CPU; it authorises nothing, and a
 * limiter that refused every request when its store blinked would be a far more
 * effective outage than the one it exists to prevent.
 */

/**
 * Refills the bucket to now, then takes a token if there is one.
 *
 * `KEYS[1]` the bucket, `ARGV` the limit, the window in milliseconds, and the
 * caller's clock. Returns how long to wait in milliseconds, `0` to proceed.
 *
 * The clock comes from the caller rather than from `TIME` so the script stays
 * deterministic. Instances whose clocks differ can only ever cost a caller
 * tokens, never grant them: time that appears to run backwards refills nothing.
 */
const SPEND = `
  local limit = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
  local tokens = tonumber(state[1])
  local at = tonumber(state[2])
  if tokens == nil or at == nil then
    tokens = limit
    at = now
  end
  local elapsed = now - at
  if elapsed > 0 then
    tokens = math.min(limit, tokens + elapsed * limit / window)
    at = now
  end
  local wait = 0
  if tokens < 1 then
    wait = math.ceil((1 - tokens) * window / limit)
  else
    tokens = tokens - 1
  end
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', at)
  redis.call('PEXPIRE', KEYS[1], window)
  return wait
`;

export interface RedisRateLimitOptions {
  readonly url: string;
  /** Reported rather than thrown: a limiter that cannot count still answers. */
  readonly onProblem?: (problem: string) => void;
}

export interface RedisRateLimit {
  /**
   * Charges one request against `key`, returning the wait in milliseconds.
   *
   * The same shape `@ponswars/api` asks a limiter for. Structural rather than a
   * shared interface, so the HTTP surface does not depend on Redis and Redis
   * does not depend on the HTTP surface.
   */
  check(key: string, rule: { readonly limit: number; readonly windowMs: number }): Promise<number>;
  close(): Promise<void>;
}

export async function redisRateLimit(options: RedisRateLimitOptions): Promise<RedisRateLimit> {
  const say = options.onProblem ?? ((): void => undefined);
  const client: RedisClientType = createClient({ url: options.url });
  client.on('error', (error: unknown) => {
    say(`redis rate limit: ${String(error)}`);
  });
  await client.connect();

  return {
    check: async (key, rule) => {
      try {
        const waitMs = await client.eval(SPEND, {
          keys: [`ponswars:rate:${key}`],
          arguments: [String(rule.limit), String(rule.windowMs), String(Date.now())],
        });
        return typeof waitMs === 'number' ? waitMs : 0;
      } catch (error: unknown) {
        say(`redis rate limit: ${String(error)}`);
        return 0;
      }
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}
