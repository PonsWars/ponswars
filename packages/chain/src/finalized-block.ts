import type { UtcTimestamp } from '@ponswars/shared-types';

/**
 * Which block breaks a tie (§12.7), found by reading the chain.
 *
 * The block is the **first block whose timestamp is at or after the battle
 * cutoff**, and it is used only once it is finalized. Both halves matter:
 *
 * - *First at or after the cutoff* fixes the block before anybody knows the
 *   result. Nobody, the operator included, can pick a later block because the
 *   earlier one broke the tie the wrong way — there is exactly one candidate,
 *   and anyone with an RPC endpoint can find it again.
 * - *Finalized* means the hash cannot change afterwards. A block that is only
 *   sequenced could still be reorganised away, and a tiebreak read from it
 *   would name a winner the chain later disagrees with.
 *
 * Block timestamps are whole seconds and several Robinhood Chain blocks share
 * one, so "first" is by block number among blocks at or after the cutoff.
 * Timestamps never decrease along the chain, which is what makes a search by
 * number correct.
 */

/** The three things a tiebreak needs to know about a block. */
export interface BlockRef {
  readonly number: bigint;
  /** Seconds since the Unix epoch, as the block header records it. */
  readonly timestamp: bigint;
  readonly hash: string;
}

/** The slice of a chain the search reads. */
export interface ChainReader {
  chainId(): Promise<number>;
  /** The newest block the chain has produced, finalized or not. */
  latestBlockNumber(): Promise<bigint>;
  /** The newest finalized block. */
  finalizedBlock(): Promise<BlockRef>;
  block(number: bigint): Promise<BlockRef>;
}

/**
 * Block `number`, once it is finalized — or `null` while it is not.
 *
 * For Genesis entropy (§9): a request is bound to a block number before that
 * block exists, and its hash is only used once finalization makes it
 * permanent. Reading it any earlier would seed a card from a hash the chain
 * could still replace.
 */
export async function finalizedBlockAt(
  reader: ChainReader,
  number: bigint,
): Promise<BlockRef | null> {
  const head = await reader.finalizedBlock();
  return head.number < number ? null : reader.block(number);
}

/**
 * The first block at or after `cutoff`, once it is finalized — or `null` while
 * the finalized head has not reached the cutoff yet.
 *
 * Reads the finalized head, then walks back in doubling steps until it passes
 * below the cutoff, then bisects. On Robinhood Chain finalization trails the
 * head by minutes and blocks arrive several a second, so the candidate is a few
 * thousand blocks behind the finalized head: a couple of dozen reads.
 */
export async function firstFinalizedBlockAtOrAfter(
  reader: ChainReader,
  cutoff: UtcTimestamp,
): Promise<BlockRef | null> {
  const cutoffMs = BigInt(cutoff);
  const reaches = (block: BlockRef): boolean => block.timestamp * 1000n >= cutoffMs;

  const head = await reader.finalizedBlock();
  if (!reaches(head)) {
    return null;
  }

  // `atOrAfter` always reaches the cutoff; `before` never does.
  let atOrAfter = head;
  let before: BlockRef;
  for (let step = 1n; ; step *= 2n) {
    if (atOrAfter.number === 0n) {
      // Genesis reaches the cutoff: it is the first block that does.
      return atOrAfter;
    }
    const candidate = await reader.block(head.number > step ? head.number - step : 0n);
    if (!reaches(candidate)) {
      before = candidate;
      break;
    }
    atOrAfter = candidate;
  }

  // Invariant: `before` is below the cutoff and `atOrAfter` reaches it, so the
  // first block that reaches it lies in (before, atOrAfter].
  let low = before.number;
  let high = atOrAfter;
  while (high.number - low > 1n) {
    const middle = await reader.block(low + (high.number - low) / 2n);
    if (reaches(middle)) {
      high = middle;
    } else {
      low = middle.number;
    }
  }
  return high;
}
