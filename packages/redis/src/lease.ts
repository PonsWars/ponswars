import { createClient } from 'redis';

/**
 * One instance drives the rounds, and the others wait (§21.3, §25).
 *
 * Every instance can serve the API and fan out events, but exactly one may run
 * the round loop: two drivers would open two rounds, tick two engines and race
 * each other into the finalization §25 makes exactly-once. That is a lock, and
 * §21.3 puts distributed locks in Redis.
 *
 * A lease rather than a lock, because the holder can die. It is taken with an
 * expiry and renewed while the work runs; an instance that stops renewing —
 * crashed, partitioned, paused long enough to matter — loses it, and another
 * takes it when the expiry passes. That is also why losing it has to stop the
 * driver rather than merely be logged: after the expiry another instance is
 * entitled to drive, and the old holder writing anything afterwards is the
 * thing the lease exists to prevent.
 *
 * Renewal and release are compare-and-set on the holder's own token, in Lua so
 * the check and the write are one operation. Without that, a holder whose lease
 * had already expired and been taken could renew — or delete — somebody else's.
 */

/** Renews only if this holder still has it. */
const RENEW = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

/** Releases only if this holder still has it. */
const RELEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/**
 * The little of a Redis client a lease uses.
 *
 * Named so the lease can be driven by something other than a live server: the
 * code that decides whether this instance may drive the rounds was the one
 * piece of §21.3 with no test at all, because reaching it meant reaching
 * Redis. The default is still a real client — `connect` below.
 */
export interface LeaseClient {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  connect(): Promise<unknown>;
  set(
    key: string,
    value: string,
    options: { condition: 'NX'; expiration: { type: 'PX'; value: number } },
  ): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface Lease {
  /** Whether this instance holds it right now. */
  readonly held: boolean;
  /** Resolves when the lease is lost, released or the signal stops it. */
  readonly lost: Promise<void>;
  /** Gives it up, so another instance can take it without waiting out the expiry. */
  release(): Promise<void>;
}

export interface LeaseOptions {
  readonly url: string;
  /** What is being led. One key per thing; the round loop uses `rounds`. */
  readonly name: string;
  /** Who is asking — an instance id, for the value that guards renewal. */
  readonly holder: string;
  /** How long the lease lives without renewal. */
  readonly ttlMs: number;
  /** Stopped when this fires. */
  readonly signal: AbortSignal;
  readonly onProblem?: (problem: string) => void;
  /** How to reach Redis. A test passes its own; everything else takes this one. */
  readonly connect?: (url: string) => LeaseClient;
}

/**
 * Waits for the lease, then holds it until it is lost or the signal stops.
 *
 * Resolves only once it is held, so a caller's next line is the work. While it
 * waits it asks again every third of the expiry — an instance taking over from
 * a crashed one waits at most the expiry plus that.
 */
export async function takeLease(options: LeaseOptions): Promise<Lease | null> {
  const say = options.onProblem ?? ((): void => undefined);
  const key = `ponswars:leader:${options.name}`;
  const client: LeaseClient = (options.connect ?? liveClient)(options.url);
  client.on('error', (error: unknown) => {
    say(`redis lease: ${String(error)}`);
  });
  await client.connect();

  const interval = Math.max(1_000, Math.floor(options.ttlMs / 3));
  const stopped = (): boolean => options.signal.aborted;

  while (!stopped()) {
    const taken = await client
      .set(key, options.holder, {
        condition: 'NX',
        expiration: { type: 'PX', value: options.ttlMs },
      })
      .catch((error: unknown) => {
        say(`redis lease: ${String(error)}`);
        return null;
      });
    if (taken === 'OK') {
      return hold(client, key, options, interval, say);
    }
    await wait(interval, options.signal);
  }

  await client.quit().catch(() => undefined);
  return null;
}

/** A real Redis client, which is what every caller but a test uses. */
function liveClient(url: string): LeaseClient {
  return createClient({ url });
}

/** Keeps a held lease alive, and says when it is not held any more. */
function hold(
  client: LeaseClient,
  key: string,
  options: LeaseOptions,
  interval: number,
  say: (problem: string) => void,
): Lease {
  let held = true;
  let resolveLost: () => void = () => undefined;
  const lost = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });

  const give = (reason: string | null): void => {
    if (!held) {
      return;
    }
    held = false;
    if (reason !== null) {
      say(reason);
    }
    clearInterval(timer);
    resolveLost();
  };

  const timer = setInterval(() => {
    void client
      .eval(RENEW, { keys: [key], arguments: [options.holder, String(options.ttlMs)] })
      .then((renewed) => {
        if (renewed !== 1) {
          // Somebody else holds it: this instance was slow, paused or
          // partitioned for longer than the lease lives.
          give(`the ${options.name} lease is no longer ours`);
        }
      })
      .catch((error: unknown) => {
        // Redis unreachable. The lease will expire on its own and another
        // instance will take it, so this one must stop now rather than keep
        // driving on the assumption it still holds something it cannot check.
        give(`the ${options.name} lease could not be renewed: ${String(error)}`);
      });
  }, interval);
  timer.unref();

  options.signal.addEventListener(
    'abort',
    () => {
      give(null);
    },
    { once: true },
  );

  return {
    get held() {
      return held;
    },
    lost,
    release: async () => {
      give(null);
      await client
        .eval(RELEASE, { keys: [key], arguments: [options.holder] })
        .catch(() => undefined);
      await client.quit().catch(() => undefined);
    },
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
