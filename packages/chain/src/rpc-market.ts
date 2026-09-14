import { createPublicClient, erc20Abi, http, parseAbi, webSocket, type PublicClient } from 'viem';
import type { MarketRpc } from './market-indexer.js';
import { pacer, type PacingOptions } from './paced.js';

/**
 * The market indexer's reads over a JSON-RPC endpoint.
 *
 * The same endpoint as the rest of the server (`RPC_URL`), on its own client so
 * the indexer's volume of log reads cannot starve a Genesis or tiebreak read of
 * a pooled connection it was waiting on.
 *
 * Every call is paced (`paced.ts`): the public endpoint answers a burst with a
 * challenge page, and a production vendor still has a rate it bills or cuts at.
 */

const AGGREGATOR_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

type Address = `0x${string}`;

export function robinhoodMarketRpc(url: string, pacing: PacingOptions): MarketRpc {
  const paced = pacer(pacing);
  const protocol = new URL(url).protocol;
  const client: PublicClient = createPublicClient({
    transport:
      protocol === 'ws:' || protocol === 'wss:'
        ? webSocket(url)
        : // Retries are the pacer's, so a throttled call backs off once rather than twice.
          http(url, { timeout: 30_000, retryCount: 0 }),
  });

  return {
    request: (method, params) =>
      paced(() =>
        client.request({ method, params } as unknown as Parameters<PublicClient['request']>[0]),
      ),
    blockNumber: () => paced(() => client.getBlockNumber({ cacheTime: 0 })),
    blockTimestamp: async (block) =>
      Number((await paced(() => client.getBlock({ blockNumber: block }))).timestamp) * 1_000,
    transactionSender: async (hash) =>
      (await paced(() => client.getTransaction({ hash: hash as Address }))).from,
    hasCode: async (address) => {
      const code = await paced(() => client.getCode({ address: address as Address }));
      return code !== undefined && code !== '0x';
    },
    tokenSymbol: (address) =>
      paced(() =>
        client.readContract({ address: address as Address, abi: erc20Abi, functionName: 'symbol' }),
      ),
    tokenDecimals: (address) =>
      paced(() =>
        client.readContract({
          address: address as Address,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
      ),
    feedDescription: (address) =>
      paced(() =>
        client.readContract({
          address: address as Address,
          abi: AGGREGATOR_ABI,
          functionName: 'description',
        }),
      ),
    feedDecimals: (address) =>
      paced(() =>
        client.readContract({
          address: address as Address,
          abi: AGGREGATOR_ABI,
          functionName: 'decimals',
        }),
      ),
    feedLatest: async (address) => {
      const [, answer, , updatedAt] = await paced(() =>
        client.readContract({
          address: address as Address,
          abi: AGGREGATOR_ABI,
          functionName: 'latestRoundData',
        }),
      );
      return { answer, updatedAt: Number(updatedAt) * 1_000 };
    },
  };
}
