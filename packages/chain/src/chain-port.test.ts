import { utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { assertChain, RpcChainPort } from './chain-port.js';
import type { BlockRef, ChainReader } from './finalized-block.js';

const CUTOFF = utcTimestamp(104_000);

function block(number: number, timestamp: number): BlockRef {
  return {
    number: BigInt(number),
    timestamp: BigInt(timestamp),
    hash: `0x${number.toString(16).padStart(64, '0')}`,
  };
}

/**
 * A chain whose finalized head advances one block per read of the head, from
 * `startAt`, over blocks stamped 100, 101, 102…
 */
function advancingChain(startAt: number, chainId = 4663): ChainReader {
  let head = startAt;
  return {
    chainId: () => Promise.resolve(chainId),
    latestBlockNumber: () => Promise.resolve(BigInt(head)),
    finalizedBlock: () => {
      const current = block(head, 100 + head);
      head += 1;
      return Promise.resolve(current);
    },
    block: (number) => Promise.resolve(block(Number(number), 100 + Number(number))),
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('RpcChainPort', () => {
  it('waits for the tiebreak block to be finalized, then answers with its hash', async () => {
    const waits: number[] = [];
    const port = new RpcChainPort(advancingChain(0), {
      pollIntervalMs: 15_000,
      sleep: noSleep,
      onWait: (cutoff) => waits.push(cutoff),
    });

    const hash = await port.finalizationBlockHash(CUTOFF);

    // Block 4 is stamped 104: the first at the cutoff.
    expect(hash).toBe(block(4, 104).hash);
    // Heads 0–3 were read before block 4 was finalized.
    expect(waits).toHaveLength(4);
  });

  it('answers with the same block however late it is asked', async () => {
    // Asked long after finalization, the answer is still the first block at the
    // cutoff — not whatever is newest by then.
    const port = new RpcChainPort(advancingChain(5_000), { pollIntervalMs: 1, sleep: noSleep });

    expect(await port.finalizationBlockHash(CUTOFF)).toBe(block(4, 104).hash);
  });

  it('retries a failed read instead of failing the finalization', async () => {
    const reader = advancingChain(10);
    let failures = 2;
    const flaky: ChainReader = {
      ...reader,
      finalizedBlock: () => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('503 from the RPC endpoint'));
        }
        return reader.finalizedBlock();
      },
    };
    const retries: unknown[] = [];
    const port = new RpcChainPort(flaky, {
      pollIntervalMs: 1,
      sleep: noSleep,
      onRetry: (_cutoff, error) => retries.push(error),
    });

    expect(await port.finalizationBlockHash(CUTOFF)).toBe(block(4, 104).hash);
    expect(retries).toHaveLength(2);
  });

  it('sleeps the poll interval between reads', async () => {
    const slept: number[] = [];
    const port = new RpcChainPort(advancingChain(2), {
      pollIntervalMs: 15_000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    await port.finalizationBlockHash(CUTOFF);

    expect(slept).toEqual([15_000, 15_000]);
  });

  it('stops waiting when its signal aborts', async () => {
    const controller = new AbortController();
    const port = new RpcChainPort(advancingChain(0), {
      pollIntervalMs: 60_000,
      signal: controller.signal,
    });

    const pending = port.finalizationBlockHash(CUTOFF);
    controller.abort(new Error('stopping'));

    await expect(pending).rejects.toThrow('stopping');
  });

  it('refuses a poll interval that is not a positive integer', () => {
    for (const pollIntervalMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new RpcChainPort(advancingChain(0), { pollIntervalMs })).toThrow(RangeError);
    }
  });
});

describe('assertChain', () => {
  it('accepts an endpoint on the configured network', async () => {
    await expect(assertChain(advancingChain(0, 46630), 46630)).resolves.toBeUndefined();
  });

  it('refuses an endpoint on another network, and names both', async () => {
    await expect(assertChain(advancingChain(0, 8453), 4663)).rejects.toThrow(
      'RPC_URL serves chain 8453, but CHAIN_ID is Robinhood Chain (4663)',
    );
    await expect(assertChain(advancingChain(0, 46630), 4663)).rejects.toThrow(
      'RPC_URL serves Robinhood Chain Testnet (46630), but CHAIN_ID is Robinhood Chain (4663)',
    );
  });
});
