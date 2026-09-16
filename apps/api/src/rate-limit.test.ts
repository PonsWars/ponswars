import { describe, expect, it } from 'vitest';
import { memoryRateLimit, type RateLimitRule } from './rate-limit.js';

/** Ten a minute: enough that the arithmetic is readable at a glance. */
const RULE: RateLimitRule = { limit: 10, windowMs: 60_000 };

describe('a sign-in allowance', () => {
  it('lets a caller who has been quiet spend the whole bucket at once', async () => {
    const limit = memoryRateLimit(() => 1_000);

    for (let request = 0; request < RULE.limit; request += 1) {
      expect(await limit('signin:1.2.3.4', RULE)).toBe(0);
    }
    expect(await limit('signin:1.2.3.4', RULE)).toBeGreaterThan(0);
  });

  it('says when the next request can succeed, rather than how long to guess', async () => {
    const limit = memoryRateLimit(() => 1_000);
    for (let request = 0; request < RULE.limit; request += 1) {
      await limit('signin:1.2.3.4', RULE);
    }

    // One token takes a tenth of the window: ten a minute is one every six
    // seconds, and a client told that waits once instead of retrying into the
    // same refusal.
    expect(await limit('signin:1.2.3.4', RULE)).toBe(6_000);
  });

  it('refills over time, so the sustained rate is the rate configured', async () => {
    let now = 1_000;
    const limit = memoryRateLimit(() => now);
    for (let request = 0; request < RULE.limit; request += 1) {
      await limit('signin:1.2.3.4', RULE);
    }

    now += 5_999;
    expect(await limit('signin:1.2.3.4', RULE)).toBeGreaterThan(0);
    now += 1;
    expect(await limit('signin:1.2.3.4', RULE)).toBe(0);

    // And never more than the bucket holds, however long the quiet lasted.
    now += 60_000 * 10;
    for (let request = 0; request < RULE.limit; request += 1) {
      expect(await limit('signin:1.2.3.4', RULE)).toBe(0);
    }
    expect(await limit('signin:1.2.3.4', RULE)).toBeGreaterThan(0);
  });

  it('counts each caller separately', async () => {
    const limit = memoryRateLimit(() => 1_000);
    for (let request = 0; request < RULE.limit; request += 1) {
      await limit('signin:1.2.3.4', RULE);
    }

    expect(await limit('signin:1.2.3.4', RULE)).toBeGreaterThan(0);
    expect(await limit('signin:5.6.7.8', RULE)).toBe(0);
  });

  it('hands nothing back when the clock jumps backwards', async () => {
    // Two instances do not share a clock, and a machine can be corrected while
    // it runs. Time that appears to run backwards must refill nothing, or the
    // limit would be whatever the worst clock in the fleet says.
    let now = 1_000_000;
    const limit = memoryRateLimit(() => now);
    for (let request = 0; request < RULE.limit; request += 1) {
      await limit('signin:1.2.3.4', RULE);
    }

    now -= 60_000;
    expect(await limit('signin:1.2.3.4', RULE)).toBeGreaterThan(0);
  });
});
