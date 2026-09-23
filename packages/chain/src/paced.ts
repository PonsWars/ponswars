/**
 * Calls to an endpoint that throttles, made politely.
 *
 * A market indexer makes far more calls than anything else in the server — a
 * whole-history discovery alone is dozens of log queries — and the public
 * Robinhood Chain endpoint answers a burst like that with a Cloudflare
 * challenge page instead of JSON. So every call goes through one queue that
 * spaces the starts of calls apart, and a call the endpoint throttles is
 * retried after a growing pause instead of failing the indexer.
 *
 * Starts are spaced, not calls: one may begin while the one before is still
 * waiting on its answer. A queue that waited for each answer would cap every
 * endpoint at one over its latency — three or four calls a second — whatever
 * rate it allowed. And a throttle pauses the whole queue, not only the call
 * that hit it, since the endpoint is saying so about all of them.
 *
 * The spacing adapts. `minIntervalMs` is the fastest the queue will go, not a
 * rate the endpoint has promised: a public endpoint's real limit moves with
 * how busy it is and who else shares the address. Each throttle doubles the
 * spacing, and each answered call wins back a sliver of it. Backing off one
 * call at a time without slowing the rest was measured to collapse — every
 * pause ended in the same burst that caused it, and the pauses grew to half a
 * minute while almost nothing was read.
 *
 * Not a JSON-RPC batch: an endpoint counts every request inside a batch
 * against its rate, so a batch saves nothing there, and a throttled batch
 * comes back as one error where a list of answers was expected.
 *
 * Only throttling is retried. Anything else — a revert, a malformed answer —
 * is passed on at once, because retrying a call that is wrong is a slower way
 * of being wrong.
 */

export interface PacingOptions {
  /** The least time between the start of one call and the next: the fastest the queue goes. */
  readonly minIntervalMs: number;
  /** How many times a throttled call is tried again. */
  readonly retries: number;
  /** The first pause after a throttled call; each further pause doubles. */
  readonly backoffMs: number;
  /** The longest single pause. */
  readonly maxBackoffMs: number;
  /**
   * Stops the queue: a call not yet started, or waiting out a pause, fails
   * with {@link PacingStopped} instead of running. A call already in flight
   * is not interrupted.
   */
  readonly signal?: AbortSignal;
  /**
   * Told each time the endpoint throttles a call: the pause that follows, and
   * the spacing the queue slowed to. A queue that is only ever waiting looks
   * exactly like one that is stuck.
   */
  readonly onThrottle?: (throttle: Throttle) => void;
  /**
   * Told each time a call is sent, retries included.
   *
   * What a vendor bills is calls sent, so choosing a plan means counting them
   * — and counting them anywhere else means counting what was asked for
   * rather than what went out.
   */
  readonly onCall?: () => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface Throttle {
  readonly pauseMs: number;
  /** Which attempt at the call was throttled, from one. */
  readonly attempt: number;
  /** The spacing between calls from now on. */
  readonly intervalMs: number;
  readonly error: unknown;
}

/** The widest a throttle spreads calls: one every five seconds still reads the chain. */
const MAX_INTERVAL_MS = 5_000;

/** The spacing a throttle starts from when the configured one is zero. */
const THROTTLED_FLOOR_MS = 50;

/** How much of the extra spacing each answered call gives back: a sixteenth. */
const RECOVERY_DIVISOR = 16;

/** A paced call refused because the queue was stopped. */
export class PacingStopped extends Error {
  constructor() {
    super('paced calls stopped');
    this.name = 'PacingStopped';
  }
}

/** Whether an error is the endpoint throttling rather than refusing. */
export function isThrottled(error: unknown): boolean {
  const text = describe(error).toLowerCase();
  return (
    text.includes('429') ||
    text.includes('too many requests') ||
    text.includes('rate limit') ||
    text.includes('just a moment') ||
    text.includes('cf_chl') ||
    text.includes('status: 403') ||
    text.includes('status: 502') ||
    text.includes('status: 503') ||
    text.includes('status: 504') ||
    text.includes('fetch failed') ||
    text.includes('timed out')
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as { details?: unknown; status?: unknown };
    return [
      error.message,
      typeof extra.details === 'string' ? extra.details.slice(0, 2_000) : '',
      typeof extra.status === 'number' ? `status: ${String(extra.status)}` : '',
      describe(error.cause),
    ].join(' ');
  }
  return typeof error === 'string' ? error : '';
}

/** A wrapper that paces and retries every function passed through it. */
export function pacer(options: PacingOptions): <T>(call: () => Promise<T>) => Promise<T> {
  const { signal } = options;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const now = options.now ?? Date.now;
  const assertRunning = (): void => {
    if (signal?.aborted === true) {
      throw new PacingStopped();
    }
  };
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  /** No call starts before this: set by a throttle, for the whole queue. */
  let resumeAt = -Infinity;
  /** The current spacing: the configured minimum, or wider after throttles. */
  let interval = options.minIntervalMs;
  /** When the spacing last widened. */
  let widenedAt = -Infinity;

  /** Waits for this call's turn to start. Turns are handed out in the order asked. */
  const slot = (): Promise<void> => {
    const turn = tail.then(async () => {
      assertRunning();
      const wait = Math.max(lastStart + interval, resumeAt) - now();
      if (wait > 0) {
        await sleep(wait);
        assertRunning();
      }
      lastStart = now();
    });
    tail = turn.catch(() => undefined);
    return turn;
  };

  return async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      await slot();
      let result: T;
      try {
        options.onCall?.();
        result = await call();
      } catch (error) {
        if (!isThrottled(error)) {
          throw error;
        }
        // Once per burst: calls already in flight when the endpoint started
        // refusing are refused together, and doubling for each of them would
        // answer one throttle with a minute of silence.
        if (now() >= widenedAt + interval) {
          interval = Math.min(
            MAX_INTERVAL_MS,
            Math.max(interval * 2, options.minIntervalMs, THROTTLED_FLOOR_MS),
          );
          widenedAt = now();
        }
        if (attempt >= options.retries) {
          throw error;
        }
        const pause = Math.min(options.maxBackoffMs, options.backoffMs * 2 ** attempt);
        resumeAt = Math.max(resumeAt, now() + pause);
        options.onThrottle?.({ pauseMs: pause, attempt: attempt + 1, intervalMs: interval, error });
        continue;
      }
      // A sixteenth back per answer, snapping home within a millisecond so the
      // spacing returns to exactly the minimum rather than approaching it.
      const narrowed = interval - (interval - options.minIntervalMs) / RECOVERY_DIVISOR;
      interval = narrowed - options.minIntervalMs < 1 ? options.minIntervalMs : narrowed;
      return result;
    }
  };
}

/** A pause that ends early when the signal fires, leaving no listener behind. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
