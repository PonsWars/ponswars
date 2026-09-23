import { describe, expect, it } from 'vitest';
import { isThrottled, pacer, PacingStopped } from './paced.js';

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
    const throttles: [number, number][] = [];
    const paced = pacer({
      minIntervalMs: 0,
      retries: 3,
      backoffMs: 500,
      maxBackoffMs: 800,
      ...fake,
      onThrottle: ({ pauseMs, attempt }) => {
        throttles.push([pauseMs, attempt]);
      },
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
    expect(throttles).toEqual([
      [500, 1],
      [800, 2],
    ]);
  });

  it('counts every call it sends, retries included, so a vendor bill can be estimated', async () => {
    const fake = clock();
    let sent = 0;
    const paced = pacer({
      minIntervalMs: 0,
      retries: 2,
      backoffMs: 1,
      maxBackoffMs: 1,
      onCall: () => {
        sent += 1;
      },
      ...fake,
    });
    let attempts = 0;
    await paced(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('429 too many requests'))
        : Promise.resolve(1);
    });
    await paced(() => Promise.resolve(2));

    // Two asked for; three went out, because one was throttled and retried.
    expect(sent).toBe(3);
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

describe('a pacer in front of a slow endpoint', () => {
  it('starts the next call on time rather than after the last answer', async () => {
    const fake = clock();
    const paced = pacer({ minIntervalMs: 100, retries: 0, backoffMs: 1, maxBackoffMs: 1, ...fake });
    const started: number[] = [];
    let answer: (() => void) | undefined;
    const slow = paced(() => {
      started.push(fake.now());
      return new Promise<void>((resolve) => {
        answer = resolve;
      });
    });
    const quick = paced(() => {
      started.push(fake.now());
      return Promise.resolve();
    });
    await quick;
    expect(started).toEqual([0, 100]);
    answer?.();
    await slow;
  });

  it('holds back every call asked for once one has been throttled', async () => {
    const fake = clock();
    const paced = pacer({
      minIntervalMs: 10,
      retries: 1,
      backoffMs: 1_000,
      maxBackoffMs: 1_000,
      ...fake,
    });
    const started: number[] = [];
    let throttle: ((error: Error) => void) | undefined;
    const throttled = paced(() => {
      started.push(fake.now());
      return started.length === 1
        ? new Promise<void>((_resolve, reject) => {
            throttle = reject;
          })
        : Promise.resolve();
    });
    await settled();
    throttle?.(new Error('HTTP request failed. Status: 429'));
    await settled();
    const next = paced(() => {
      started.push(fake.now());
      return Promise.resolve();
    });
    await Promise.all([throttled, next]);
    expect(started).toHaveLength(3);
    expect(started[0]).toBe(0);
    for (const at of started.slice(1)) {
      expect(at).toBeGreaterThanOrEqual(1_000);
    }
  });
});

/** Lets every already-queued continuation run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

describe('a pacer the endpoint keeps throttling', () => {
  it('spaces calls further apart, then wins the spacing back as calls are answered', async () => {
    const fake = clock();
    const intervals: number[] = [];
    const paced = pacer({
      minIntervalMs: 100,
      retries: 5,
      backoffMs: 1,
      maxBackoffMs: 1,
      ...fake,
      onThrottle: ({ intervalMs }) => {
        intervals.push(intervalMs);
      },
    });
    let throttleNext = 2;
    const call = (): Promise<number> =>
      paced(() => {
        if (throttleNext > 0) {
          throttleNext -= 1;
          return Promise.reject(new Error('HTTP request failed. Status: 429'));
        }
        return Promise.resolve(fake.now());
      });

    await call();
    expect(intervals).toEqual([200, 400]);

    // The next call waits out the widened spacing, not the configured one.
    const before = fake.now();
    const startedAt = await call();
    expect(startedAt - before).toBeGreaterThanOrEqual(375);

    // Answered calls narrow it again, and it never goes below the minimum.
    for (let index = 0; index < 200; index += 1) {
      await call();
    }
    const last = fake.now();
    expect((await call()) - last).toBe(100);
  });

  it('slows once for a burst of calls refused together', async () => {
    const fake = clock();
    const intervals: number[] = [];
    const paced = pacer({
      minIntervalMs: 0,
      retries: 1,
      backoffMs: 1,
      maxBackoffMs: 1,
      ...fake,
      onThrottle: ({ intervalMs }) => {
        intervals.push(intervalMs);
      },
    });
    let answer: ((error: Error) => void)[] = [];
    let refuse = true;
    const calls = [1, 2, 3].map(() =>
      paced(() =>
        refuse
          ? new Promise<void>((_resolve, reject) => {
              answer.push(reject);
            })
          : Promise.resolve(),
      ),
    );
    // Until all three are in flight together.
    for (let turn = 0; turn < 100 && answer.length < 3; turn += 1) {
      await Promise.resolve();
    }
    expect(answer).toHaveLength(3);
    refuse = false;
    const refusals = answer;
    answer = [];
    for (const reject of refusals) {
      reject(new Error('HTTP request failed. Status: 429'));
    }
    await Promise.all(calls);

    expect(intervals).toEqual([50, 50, 50]);
  });
});

describe('a stopped pacer', () => {
  it('refuses queued calls and gives up a throttled retry', async () => {
    const controller = new AbortController();
    const fake = clock();
    const paced = pacer({
      minIntervalMs: 0,
      retries: 5,
      backoffMs: 100,
      maxBackoffMs: 100,
      signal: controller.signal,
      ...fake,
    });
    let calls = 0;
    const throttled = paced(() => {
      calls += 1;
      controller.abort();
      return Promise.reject(new Error('HTTP request failed. Status: 429'));
    });
    const queued = paced(() => Promise.resolve('never'));
    await expect(throttled).rejects.toBeInstanceOf(PacingStopped);
    await expect(queued).rejects.toBeInstanceOf(PacingStopped);
    expect(calls).toBe(1);
  });

  it('ends a real pause as soon as it is stopped', async () => {
    const controller = new AbortController();
    const paced = pacer({
      minIntervalMs: 60_000,
      retries: 0,
      backoffMs: 1,
      maxBackoffMs: 1,
      signal: controller.signal,
    });
    await paced(() => Promise.resolve(1));
    const second = paced(() => Promise.resolve(2));
    controller.abort();
    await expect(second).rejects.toBeInstanceOf(PacingStopped);
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
