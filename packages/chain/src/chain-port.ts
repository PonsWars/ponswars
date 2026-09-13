import type { ChainPort } from '@ponswars/round-service';
import { chainLabel, type UtcTimestamp } from '@ponswars/shared-types';
import { firstFinalizedBlockAtOrAfter, type ChainReader } from './finalized-block.js';

/**
 * The round loop's chain port, over a real chain (§12.7, §13.6).
 *
 * Asked only when a battle is level through every market component, and
 * answers once the tiebreak block is finalized. Until then it waits — on
 * Robinhood Chain finalization trails the head by minutes, so a dead heat
 * finalizes that much later than its cutoff. That is the honest cost of a
 * tiebreak nobody can predict or re-roll, and the alternatives are worse: a
 * block that is not yet final could be reorganised into a different winner,
 * and a block chosen later than the first one after the cutoff is a block
 * somebody chose.
 *
 * A failed read is retried rather than raised. An RPC endpoint that blinks for
 * a few seconds is not a reason to stop the round loop; the retry is reported
 * through `onRetry`, so an endpoint that stays down is visible in the logs
 * instead of silently stalling a finalization.
 */
export interface RpcChainPortOptions {
  /** How long to wait between reads while the block is not yet finalized. */
  readonly pollIntervalMs: number;
  /** Stops the wait. The pending call rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  readonly onWait?: (cutoff: UtcTimestamp) => void;
  readonly onRetry?: (cutoff: UtcTimestamp, error: unknown) => void;
  /** Injected for tests; a timer by default. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class RpcChainPort implements ChainPort {
  readonly #reader: ChainReader;
  readonly #options: RpcChainPortOptions;

  constructor(reader: ChainReader, options: RpcChainPortOptions) {
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
      throw new RangeError('pollIntervalMs must be a positive integer');
    }
    this.#reader = reader;
    this.#options = options;
  }

  async finalizationBlockHash(at: UtcTimestamp): Promise<string> {
    const { signal, pollIntervalMs, onWait, onRetry, sleep = abortableSleep } = this.#options;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const block = await firstFinalizedBlockAtOrAfter(this.#reader, at);
        if (block !== null) {
          return block.hash;
        }
        onWait?.(at);
      } catch (error: unknown) {
        onRetry?.(at, error);
      }
      await sleep(pollIntervalMs, signal);
    }
  }
}

/**
 * Refuses an RPC endpoint on a chain other than the configured one.
 *
 * `CHAIN_ID` is never inferred from the endpoint — but it is checked against
 * it, once, at startup. An endpoint for another network would otherwise break
 * ties from blocks on a chain PonsWars does not run on, and nothing about the
 * hashes it returned would look wrong.
 */
export async function assertChain(reader: ChainReader, expected: number): Promise<void> {
  const actual = await reader.chainId();
  if (actual !== expected) {
    throw new Error(
      `RPC_URL serves ${chainLabel(actual)}, but CHAIN_ID is ${chainLabel(expected)}. ` +
        'Point RPC_URL at the configured Robinhood Chain network.',
    );
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
