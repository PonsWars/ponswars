import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeLease, type LeaseClient } from './lease.js';

/**
 * Who may drive the rounds (§21.3, §25).
 *
 * The rule this enforces is that exactly one instance runs the round loop, and
 * the failure it exists to prevent is two: two rounds opened, two engines
 * ticking, two attempts at a finalization §25 makes exactly-once. So the cases
 * that matter are the unhappy ones — a lease that cannot be renewed, one that
 * somebody else now holds, a Redis that has gone away — and in every one of
 * them the holder must stop.
 */

interface Call {
  readonly kind: 'set' | 'eval';
  readonly script?: string;
  readonly args: readonly string[];
}

/** A Redis that answers whatever the test says, and remembers what it was asked. */
function fakeRedis(answers: {
  set?: (attempt: number) => string | null;
  eval?: (attempt: number) => unknown;
}): { client: LeaseClient; calls: Call[]; quits: number } {
  const calls: Call[] = [];
  const state = { sets: 0, evals: 0, quits: 0 };
  const client: LeaseClient = {
    on: () => undefined,
    connect: () => Promise.resolve(undefined),
    set: (key, value) => {
      state.sets += 1;
      calls.push({ kind: 'set', args: [key, value] });
      // Not `?? 'OK'`: `null` is Redis refusing the key, which is the answer
      // half these tests are about.
      return Promise.resolve(answers.set === undefined ? 'OK' : answers.set(state.sets));
    },
    eval: (script, options) => {
      state.evals += 1;
      calls.push({ kind: 'eval', script, args: options.arguments });
      const answer = answers.eval === undefined ? 1 : answers.eval(state.evals);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    quit: () => {
      state.quits += 1;
      return Promise.resolve(undefined);
    },
  };
  return {
    client,
    calls,
    get quits() {
      return state.quits;
    },
  };
}

const TTL = 9_000;

function options(
  client: LeaseClient,
  signal: AbortSignal,
  onProblem?: (problem: string) => void,
): Parameters<typeof takeLease>[0] {
  return {
    url: 'redis://unused',
    name: 'rounds',
    holder: 'instance-a',
    ttlMs: TTL,
    signal,
    connect: () => client,
    ...(onProblem === undefined ? {} : { onProblem }),
  };
}

let stop: AbortController;

beforeEach(() => {
  vi.useFakeTimers();
  stop = new AbortController();
});

afterEach(() => {
  stop.abort();
  vi.useRealTimers();
});

describe('taking the lease', () => {
  it('holds it when Redis had nobody else in the key', async () => {
    const redis = fakeRedis({});

    const lease = await takeLease(options(redis.client, stop.signal));

    expect(lease?.held).toBe(true);
    // Set under the one key §21.3 names, with this instance as the value: the
    // value is what every renewal is checked against.
    expect(redis.calls[0]).toEqual({
      kind: 'set',
      args: ['ponswars:leader:rounds', 'instance-a'],
    });
  });

  it('waits and asks again while another instance holds it', async () => {
    // `null` is Redis refusing SET NX: somebody else has the key.
    const redis = fakeRedis({ set: (attempt) => (attempt < 3 ? null : 'OK') });

    const taking = takeLease(options(redis.client, stop.signal));
    await vi.advanceTimersByTimeAsync(TTL);
    const lease = await taking;

    expect(lease?.held).toBe(true);
    expect(redis.calls.filter((call) => call.kind === 'set')).toHaveLength(3);
  });

  it('gives up when the signal stops it before it ever held one', async () => {
    const redis = fakeRedis({ set: () => null });

    const taking = takeLease(options(redis.client, stop.signal));
    stop.abort();
    await vi.advanceTimersByTimeAsync(TTL);

    expect(await taking).toBeNull();
    // The connection goes back rather than being left open by a process that
    // is shutting down.
    expect(redis.quits).toBe(1);
  });
});

describe('holding it', () => {
  it('renews with its own token, well inside the expiry', async () => {
    const redis = fakeRedis({});

    const lease = await takeLease(options(redis.client, stop.signal));
    await vi.advanceTimersByTimeAsync(TTL);

    const renewals = redis.calls.filter((call) => call.kind === 'eval');
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    // The holder's own token, so a lease that expired and was taken by another
    // instance cannot be renewed from here.
    expect(renewals[0]?.args).toEqual(['instance-a', String(TTL)]);
    expect(renewals[0]?.script).toContain('PEXPIRE');
    expect(lease?.held).toBe(true);
  });

  it('stops when the renewal says the lease is somebody else’s now', async () => {
    const said: string[] = [];
    const redis = fakeRedis({ eval: (attempt) => (attempt === 1 ? 0 : 1) });

    const lease = await takeLease(options(redis.client, stop.signal, (p) => said.push(p)));
    await vi.advanceTimersByTimeAsync(TTL);
    await lease?.lost;

    expect(lease?.held).toBe(false);
    expect(said.join(' ')).toContain('no longer ours');
  });

  it('stops when Redis cannot be reached to renew it', async () => {
    // The dangerous case: this instance cannot check whether it still holds
    // the lease, so it must not keep driving as though it does.
    const said: string[] = [];
    const redis = fakeRedis({ eval: () => new Error('connection lost') });

    const lease = await takeLease(options(redis.client, stop.signal, (p) => said.push(p)));
    await vi.advanceTimersByTimeAsync(TTL);
    await lease?.lost;

    expect(lease?.held).toBe(false);
    expect(said.join(' ')).toContain('could not be renewed');
  });

  it('stops renewing once it is lost, rather than talking to a key it does not hold', async () => {
    const redis = fakeRedis({ eval: (attempt) => (attempt === 1 ? 0 : 1) });

    const lease = await takeLease(options(redis.client, stop.signal));
    await vi.advanceTimersByTimeAsync(TTL);
    await lease?.lost;
    const afterLoss = redis.calls.filter((call) => call.kind === 'eval').length;
    await vi.advanceTimersByTimeAsync(TTL * 3);

    expect(redis.calls.filter((call) => call.kind === 'eval')).toHaveLength(afterLoss);
  });

  it('stops when the signal fires, without waiting out the expiry', async () => {
    const redis = fakeRedis({});

    const lease = await takeLease(options(redis.client, stop.signal));
    stop.abort();
    await lease?.lost;

    expect(lease?.held).toBe(false);
  });
});

describe('giving it back', () => {
  it('releases under its own token and closes the connection', async () => {
    const redis = fakeRedis({});

    const lease = await takeLease(options(redis.client, stop.signal));
    await lease?.release();
    await lease?.lost;

    const release = redis.calls.filter((call) => call.kind === 'eval').at(-1);
    expect(release?.script).toContain('DEL');
    expect(release?.args).toEqual(['instance-a']);
    expect(lease?.held).toBe(false);
    expect(redis.quits).toBe(1);
  });
});
