import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import type { BlockRef, ChainReader } from './finalized-block.js';

/**
 * A `ChainReader` over a JSON-RPC endpoint.
 *
 * Any Robinhood Chain endpoint serves: the public one, or a vendor's — which
 * one is `RPC_URL`, and the vendor is still `OPEN` (§59.3). Nothing here is
 * specific to a vendor, so choosing one is configuration and not code.
 *
 * Every answer is checked before it is used. An endpoint that returns a block
 * other than the one asked for, or one with no hash, would otherwise decide a
 * tie from a block nobody can find again.
 */
export function rpcChainReader(url: string): ChainReader {
  const protocol = new URL(url).protocol;
  const client: PublicClient = createPublicClient({
    transport: protocol === 'ws:' || protocol === 'wss:' ? webSocket(url) : http(url),
  });

  return {
    chainId: () => client.getChainId(),
    finalizedBlock: async () => refOf(await client.getBlock({ blockTag: 'finalized' }), null),
    block: async (number) => refOf(await client.getBlock({ blockNumber: number }), number),
  };
}

function refOf(
  block: {
    readonly number: bigint | null;
    readonly timestamp: bigint;
    readonly hash: string | null;
  },
  asked: bigint | null,
): BlockRef {
  if (block.number === null || block.hash === null) {
    throw new Error('The RPC endpoint answered with a pending block, not a finalized one');
  }
  if (asked !== null && block.number !== asked) {
    throw new Error(
      `The RPC endpoint answered block ${block.number.toString()} when asked for ${asked.toString()}`,
    );
  }
  return { number: block.number, timestamp: block.timestamp, hash: block.hash };
}
