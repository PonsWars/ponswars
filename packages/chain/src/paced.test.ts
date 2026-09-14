import { describe, expect, it } from 'vitest';
import { isThrottled, pacer } from './paced.js';

/** A fake clock whose sleeps advance it, so pacing is observable without waiting. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let time = 0;
  const slept: number[] = [];
  return {
    now: () => time,
    sleep: (ms) => {
      slept.push(ms);
      time += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('pacer', () => {
  it('spaces calls apart and runs them in order', async () => {
    const fake = clock();
    const paced = pacer({ minIntervalMs: 100, retries: 0, backoffMs: 1, maxBackoffMs: 1, ...fake });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((value) => paced(() => Promise.resolve(order.push(value)))));
    expect(order).toEqual([1, 2, 3]);
    expect(fake.slept).toEqual([100, 100]);
  });

  it('retries a throttled call after a doubling pause, and then succeeds', async () => {
    const fake = clock();
    const paced = pacer({
      minIntervalMs: 0,
      retries: 3,
      backoffMs: 500,
      maxBackoffMs: 800,
      ...fake,
    });
    let calls = 0;
    const result = await paced(() => {
      calls += 1;
      return calls < 3
        ? Promise.reject(new Error('HTTP request failed. Status: 429'))
        : Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(fake.slept).toEqual([500, 800]);
  });

  it('passes on an error that is not throttling without retrying', async () => {
    const fake = clock();
    const paced = pacer({ minIntervalMs: 0, retries: 5, backoffMs: 1, maxBackoffMs: 1, ...fake });
    let calls = 0;
    await expect(
      paced(() => {
        calls += 1;
        return Promise.reject(new Error('execution reverted'));
      }),
    ).rejects.toThrow('execution reverted');
    expect(calls).toBe(1);
  });

  it('keeps going after a call fails', async () => {
    const fake = clock();
    const paced = pacer({ minIntervalMs: 0, retries: 0, backoffMs: 1, maxBackoffMs: 1, ...fake });
    await expect(paced(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await paced(() => Promise.resolve(7))).toBe(7);
  });
});

describe('isThrottled', () => {
  it('recognises a Cloudflare challenge page and a 429', () => {
    const challenge = Object.assign(new Error('HTTP request failed.'), {
      details: '<!DOCTYPE html><html><head><title>Just a moment...</title>',
    });
    expect(isThrottled(challenge)).toBe(true);
    expect(isThrottled(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isThrottled(new Error('execution reverted'))).toBe(false);
  });
});
