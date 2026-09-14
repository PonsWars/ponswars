/**
 * Calls to an endpoint that throttles, made politely.
 *
 * A market indexer makes far more calls than anything else in the server — a
 * whole-history discovery alone is dozens of log queries — and the public
 * Robinhood Chain endpoint answers a burst like that with a Cloudflare
 * challenge page instead of JSON. So every call goes through one queue that
 * spaces calls apart, and a call the endpoint throttles is retried after a
 * growing pause instead of failing the indexer.
 *
 * Only throttling is retried. Anything else — a revert, a malformed answer —
 * is passed on at once, because retrying a call that is wrong is a slower way
 * of being wrong.
 */

export interface PacingOptions {
  /** The least time between the start of one call and the next. */
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
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

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

  const slot = async (): Promise<void> => {
    assertRunning();
    const wait = lastStart + options.minIntervalMs - now();
    if (wait > 0) {
      await sleep(wait);
      assertRunning();
    }
    lastStart = now();
  };

  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt += 1) {
        await slot();
        try {
          return await call();
        } catch (error) {
          if (attempt >= options.retries || !isThrottled(error)) {
            throw error;
          }
          await sleep(Math.min(options.maxBackoffMs, options.backoffMs * 2 ** attempt));
        }
      }
    };
    // Serial: one call at a time, in the order they were asked for.
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
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
