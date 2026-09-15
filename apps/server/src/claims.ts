import { readRewardClaims, type RpcRequest } from '@ponswars/chain';
import type { PostgresClaimStore } from '@ponswars/store-postgres';

/**
 * Reading reward claims off the chain into the record (§17, §35.6).
 *
 * A claim is the player's own transaction to the distributor, and this service
 * neither sends it nor hears about it. So it reads the `Claimed` events, from
 * where it last read to the head, and records what it finds. Two things depend
 * on that record: a claims page that can say "claimed" without an RPC call per
 * allocation, and a distribution whose take-up is answerable later.
 *
 * Slow on purpose. Claims are rare — one per wallet per day at most (§16.2) —
 * and nothing in the product waits on this: the page a player claims from
 * re-reads the contract itself right after the transaction confirms.
 *
 * The cursor moves only after the rows are written, so a crash between the two
 * re-reads a window rather than skipping it, and a re-read records nothing new.
 */

/** How often the chain is asked for new claims. */
const READ_INTERVAL_MS = 30_000;

/** The widest block range asked for at once; `scanLogs` splits it further if refused. */
const MAX_BLOCKS_PER_READ = 50_000n;

export interface ClaimReaderOptions {
  readonly store: PostgresClaimStore;
  readonly request: RpcRequest;
  readonly headBlock: () => Promise<bigint>;
  readonly distributor: `0x${string}`;
  readonly signal: AbortSignal;
  readonly say: (line: string) => void;
  /** Where to start when nothing has been read yet: the distributor's deployment. */
  readonly from?: bigint;
}

/** The reader's name in `indexer_cursors`. */
export const CLAIM_CURSOR = 'reward-claims';

export async function followClaims(options: ClaimReaderOptions): Promise<void> {
  const { store, request, distributor, signal, say } = options;
  // Read through a call: TypeScript narrows the loop's guard and keeps that
  // narrowing across the awaits, where at runtime this is exactly what changes.
  const stopping = (): boolean => signal.aborted;
  let failing = false;
  while (!stopping()) {
    try {
      const head = await options.headBlock();
      const cursor = await store.cursor(CLAIM_CURSOR);
      const from = cursor === null ? (options.from ?? 0n) : cursor + 1n;
      if (from <= head) {
        const to = head - from + 1n > MAX_BLOCKS_PER_READ ? from + MAX_BLOCKS_PER_READ - 1n : head;
        const claims = await readRewardClaims(request, distributor, from, to);
        const written = await store.record(claims);
        await store.advance(CLAIM_CURSOR, to);
        if (written > 0) {
          say(`recorded ${String(written)} reward claim(s) from the chain\n`);
        }
      }
      if (failing) {
        say('reading reward claims again\n');
        failing = false;
      }
    } catch (error) {
      if (stopping()) {
        return;
      }
      // Nothing waits on this read, so a failed one is said once and retried.
      if (!failing) {
        say(`reading reward claims failed, retrying: ${String(error)}\n`);
        failing = true;
      }
    }
    await wait(READ_INTERVAL_MS, signal);
  }
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
