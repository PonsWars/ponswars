import { utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  finalizedBlockAt,
  firstFinalizedBlockAtOrAfter,
  type BlockRef,
  type ChainReader,
} from './finalized-block.js';

/**
 * A chain of `timestamps.length` blocks, finalized up to `finalized`.
 *
 * Block `n` has timestamp `timestamps[n]` seconds and hash `0x…n`, so a test
 * reads which block was chosen straight off its hash. Every read is counted.
 */
function chain(
  timestamps: readonly number[],
  finalized = timestamps.length - 1,
): ChainReader & { reads: () => number } {
  let reads = 0;
  const at = (number: number): BlockRef => {
    const timestamp = timestamps[number];
    if (timestamp === undefined || number > finalized) {
      throw new Error(`block ${String(number)} is not finalized`);
    }
    return {
      number: BigInt(number),
      timestamp: BigInt(timestamp),
      hash: `0x${number.toString(16).padStart(64, '0')}`,
    };
  };
  return {
    chainId: () => Promise.resolve(4663),
    latestBlockNumber: () => Promise.resolve(BigInt(timestamps.length - 1)),
    finalizedBlock: () => {
      reads += 1;
      return Promise.resolve(at(finalized));
    },
    block: (number) => {
      reads += 1;
      return Promise.resolve(at(Number(number)));
    },
    reads: () => reads,
  };
}

const seconds = (value: number) => utcTimestamp(value * 1000);

/** The first index whose timestamp reaches `cutoff`, by reading every block. */
function expected(timestamps: readonly number[], cutoffSeconds: number): number {
  return timestamps.findIndex((timestamp) => timestamp >= cutoffSeconds);
}

describe('finalizedBlockAt (§9)', () => {
  it('is nothing while the block is not finalized, then the block itself', async () => {
    const timestamps = [100, 101, 102, 103, 104, 105];

    expect(await finalizedBlockAt(chain(timestamps, 3), 4n)).toBeNull();
    const block = await finalizedBlockAt(chain(timestamps, 4), 4n);
    expect(block?.number).toBe(4n);
    expect(block?.hash).toBe(`0x${'4'.padStart(64, '0')}`);
  });
});

describe('firstFinalizedBlockAtOrAfter (§12.7)', () => {
  it('is the first block at the cutoff, when several share its second', async () => {
    // Robinhood Chain seals several blocks a second.
    const timestamps = [100, 100, 101, 101, 101, 102, 102, 103];

    const block = await firstFinalizedBlockAtOrAfter(chain(timestamps), seconds(101));

    expect(block?.number).toBe(2n);
  });

  it('is the first block after the cutoff when no block lands on it', async () => {
    const timestamps = [100, 104, 108, 112];

    const block = await firstFinalizedBlockAtOrAfter(chain(timestamps), seconds(105));

    expect(block?.number).toBe(2n);
  });

  it('counts a cutoff inside a second as after every block stamped with that second', async () => {
    // Timestamps are whole seconds; a cutoff at 101.5 s is not reached by a
    // block stamped 101, which may have been sealed before it.
    const timestamps = [100, 101, 101, 102];

    const block = await firstFinalizedBlockAtOrAfter(chain(timestamps), utcTimestamp(101_500));

    expect(block?.number).toBe(3n);
  });

  it('is nothing yet while the finalized head is still before the cutoff', async () => {
    // Blocks 0–5 exist; only 0–3 are finalized, and the cutoff is at block 4.
    const timestamps = [100, 101, 102, 103, 104, 105];

    expect(await firstFinalizedBlockAtOrAfter(chain(timestamps, 3), seconds(104))).toBeNull();
    expect((await firstFinalizedBlockAtOrAfter(chain(timestamps, 5), seconds(104)))?.number).toBe(
      4n,
    );
  });

  it('is genesis when every block reaches the cutoff', async () => {
    const block = await firstFinalizedBlockAtOrAfter(chain([500, 501, 502]), seconds(1));

    expect(block?.number).toBe(0n);
  });

  it('is the finalized head itself when only the head reaches the cutoff', async () => {
    const block = await firstFinalizedBlockAtOrAfter(chain([1, 2, 3, 4, 9]), seconds(9));

    expect(block?.number).toBe(4n);
  });

  it('agrees with reading every block, for every cutoff on an uneven chain', async () => {
    // Deterministic, uneven gaps including runs of equal timestamps.
    const timestamps: number[] = [];
    let now = 1_000;
    for (let index = 0; index < 300; index += 1) {
      now += (index * 7919) % 3;
      timestamps.push(now);
    }
    const last = timestamps.at(-1) ?? 0;

    for (let cutoff = 999; cutoff <= last; cutoff += 1) {
      const block = await firstFinalizedBlockAtOrAfter(chain(timestamps), seconds(cutoff));
      expect(block?.number).toBe(BigInt(expected(timestamps, cutoff)));
    }
  });

  it('reads a few dozen blocks, not thousands, far behind the head', async () => {
    // Ten blocks a second for two hours: the cutoff sits an hour behind the head.
    const timestamps = Array.from({ length: 72_000 }, (_, index) => 1_000 + Math.floor(index / 10));
    const reader = chain(timestamps);

    const block = await firstFinalizedBlockAtOrAfter(reader, seconds(1_000 + 3_600));

    expect(block?.number).toBe(36_000n);
    expect(reader.reads()).toBeLessThan(40);
  });
});
