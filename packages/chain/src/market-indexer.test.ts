import { ACTIVE_TICKERS, utcTimestamp } from '@ponswars/shared-types';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { RawLog } from './log-scan.js';
import { MARKET_EVENTS_ABI } from './market-events.js';
import { RobinhoodMarketIndexer, type MarketRpc } from './market-indexer.js';
import { ROBINHOOD_CHAIN_MAINNET_MARKET as MARKET } from './robinhood-market.js';

/** One block a second, starting at a Wednesday 2026-09-16 14:00 UTC. */
const GENESIS_MS = Date.parse('2026-09-16T14:00:00Z');
const blockTime = (block: number): number => GENESIS_MS + block * 1_000;

const TOKEN = MARKET.tickers.NVDA.token.toLowerCase() as Hex;
const USDG = MARKET.usdg.toLowerCase() as Hex;
const USDG_POOL: Hex = `0x${'11'.repeat(32)}`;
const PONS_POOL: Hex = `0x${'22'.repeat(32)}`;
const MEMECOIN: Hex = '0x00000000000000000000000000000000000000ff';
const CURVE: Hex = '0x00000000000000000000000000000000000000c1';
const TRADER: Hex = '0x00000000000000000000000000000000000000aa';
const ROUTED_TX = '0xfeed';

let logIndex = 0;
function raw(
  address: string,
  topics: readonly Hex[],
  data: Hex,
  block: number,
  transactionHash = `0x${block.toString(16)}${String(logIndex)}`,
): RawLog {
  logIndex += 1;
  return {
    address,
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: '0x00',
    transactionHash,
    logIndex: `0x${logIndex.toString(16)}`,
    blockTimestamp: `0x${Math.floor(blockTime(block) / 1_000).toString(16)}`,
  };
}

const initialize = (block: number): RawLog =>
  raw(
    MARKET.poolManager,
    encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'Initialize',
      // USDG sorts before the NVDA token, so it is currency0.
      args: { id: USDG_POOL, currency0: USDG, currency1: TOKEN },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters('uint24, int24, address, uint160, int24'), [
      3000,
      60,
      '0x0000000000000000000000000000000000000000',
      1n,
      0,
    ]),
    block,
  );

const swap = (pool: Hex, amount0: bigint, amount1: bigint, block: number, tx?: string): RawLog =>
  raw(
    MARKET.poolManager,
    encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'Swap',
      args: { id: pool, sender: MARKET.routers[0] },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters('int128, int128, uint160, uint128, int24, uint24'), [
      amount0,
      amount1,
      1n,
      1n,
      0,
      3000,
    ]),
    block,
    tx,
  );

const registered = (block: number): RawLog =>
  raw(
    MARKET.ponsMemeHook,
    encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'PoolRegistered',
      args: { poolId: PONS_POOL },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters('address, address, address'), [MEMECOIN, TOKEN, TRADER]),
    block,
  );

const curveBuy = (quoteIn: bigint, recipient: Hex, block: number): RawLog =>
  raw(
    CURVE,
    encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'CurveBuy',
      args: { buyer: recipient, recipient },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256'), [
      quoteIn,
      1n,
      0n,
      0n,
    ]),
    block,
  );

/** The Pons factory launching CURVE, quoted in the NVDA token. */
const launched = (
  block: number,
  curve: Hex = CURVE,
  emitter: string = MARKET.ponsFactory,
): RawLog =>
  raw(
    emitter,
    encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'TokenLaunched',
      args: { token: MEMECOIN, curve, deployer: TRADER },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters('address, uint256, uint256'), [TOKEN, 1n, 1n]),
    block,
  );

/** A chain made of the logs given, answering the reads the indexer makes. */
function fakeChain(
  logs: RawLog[],
  symbols: Partial<Record<string, string>> = {},
): {
  rpc: MarketRpc;
  head: { value: number };
} {
  const head = { value: 1_000 };
  const matches = (log: RawLog, filter: { address?: string | string[]; topics?: unknown[] }) => {
    if (filter.address !== undefined) {
      const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map(
        (entry) => entry.toLowerCase(),
      );
      if (!addresses.includes(log.address.toLowerCase())) {
        return false;
      }
    }
    return (filter.topics ?? []).every((wanted, index) => {
      const actual = log.topics[index]?.toLowerCase();
      if (wanted === null) return true;
      if (Array.isArray(wanted))
        return wanted.map((w: string) => w.toLowerCase()).includes(actual ?? '');
      return typeof wanted === 'string' && wanted.toLowerCase() === actual;
    });
  };
  const rpc: MarketRpc = {
    request: (method, params) => {
      if (method !== 'eth_getLogs') throw new Error(method);
      const filter = params[0] as {
        address?: string | string[];
        topics?: unknown[];
        fromBlock: string;
        toBlock: string;
      };
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      return Promise.resolve(
        logs.filter((log) => {
          const block = Number(BigInt(log.blockNumber));
          return block >= from && block <= to && block <= head.value && matches(log, filter);
        }),
      );
    },
    blockNumber: () => Promise.resolve(BigInt(head.value)),
    blockTimestamp: (block) => Promise.resolve(blockTime(Number(block))),
    transactionSenders: (hashes) =>
      Promise.resolve(
        new Map(
          hashes.map((hash) => [
            hash,
            hash === ROUTED_TX ? '0x00000000000000000000000000000000000000Bb' : TRADER,
          ]),
        ),
      ),
    hasCode: () => Promise.resolve(true),
    tokenSymbol: (address) => {
      const ticker = ACTIVE_TICKERS.find(
        (entry) => MARKET.tickers[entry].token.toLowerCase() === address.toLowerCase(),
      );
      return Promise.resolve(symbols[address.toLowerCase()] ?? ticker ?? 'USDG');
    },
    tokenDecimals: (address) => Promise.resolve(address.toLowerCase() === USDG ? 6 : 18),
    feedDescription: (address) => {
      const ticker = ACTIVE_TICKERS.find(
        (entry) => MARKET.tickers[entry].referenceFeed.toLowerCase() === address.toLowerCase(),
      );
      return Promise.resolve(`RH${String(ticker)} / USD`);
    },
    feedDecimals: () => Promise.resolve(8),
    feedLatest: () => Promise.resolve({ answer: 200n * 100_000_000n, updatedAt: blockTime(900) }),
  };
  return { rpc, head };
}

function indexer(rpc: MarketRpc): RobinhoodMarketIndexer {
  return new RobinhoodMarketIndexer({
    rpc,
    addresses: MARKET,
    tradeRetentionMs: 3_600_000,
    volumeRetentionMs: 3_600_000,
    minTradeQuote: 1_000_000n,
    ponsRetentionMs: 3_600_000,
    maxBlocksPerPoll: 10_000n,
    referenceRefreshMs: 60_000,
    now: () => blockTime(1_000),
  });
}

const all = { from: utcTimestamp(0), to: utcTimestamp(Number.MAX_SAFE_INTEGER) };

describe('RobinhoodMarketIndexer', () => {
  it('discovers the USDG pool and backfills its trades with both sides the right way round', async () => {
    const chain = fakeChain([
      initialize(10),
      // The pool pays out 1 NVDA for 210 USDG: amounts are signed, sizes are not.
      swap(USDG_POOL, 210_000_000n, -(10n ** 18n), 500),
    ]);
    const market = indexer(chain.rpc);
    await market.start();

    expect(market.trades('NVDA', all)).toEqual([
      expect.objectContaining({ quoteAmount: 210_000_000n, tokenAmount: 10n ** 18n }),
    ]);
    expect(market.trades('AAPL', all)).toEqual([]);
    expect(market.notional('NVDA', all)).toBe(210_000_000n);
    expect(market.units('NVDA')).toEqual({ quoteDecimals: 6, tokenDecimals: 18 });
    expect(market.reference('NVDA')?.price).toBe(200n * 100_000_000n);
    expect(market.coversUntil()).toBe(blockTime(1_000));
  });

  it('dates trades itself when the endpoint sends a zero block timestamp, as the public one does', async () => {
    const undated = (log: RawLog): RawLog => ({ ...log, blockTimestamp: '0x0' });
    const chain = fakeChain([
      undated(initialize(10)),
      undated(swap(USDG_POOL, 210_000_000n, -(10n ** 18n), 500)),
    ]);
    const market = indexer(chain.rpc);
    await market.start();

    expect(market.trades('NVDA', all).map((trade) => trade.at)).toEqual([blockTime(500)]);
    expect(market.notional('NVDA', all)).toBe(210_000_000n);
  });

  it('counts Pons trading quoted in the ticker — its curve asked about when first seen — sized in dollars and credited to the trader', async () => {
    const chain = fakeChain([
      registered(30),
      launched(20),
      // 0.5 NVDA into the curve, at the $200 reference: $100.
      curveBuy(5n * 10n ** 17n, TRADER, 600),
      // A graduated-pool swap sent through a router: the trader is the transaction's
      // sender. The memecoin sorts first, so the ticker's 1 NVDA is `amount1`.
      swap(PONS_POOL, -(10n ** 21n), 10n ** 18n, 700, ROUTED_TX),
    ]);
    const market = indexer(chain.rpc);
    await market.start();

    const activity = market.ponsActivity('NVDA', all);
    expect(activity.map((entry) => [entry.wallet, entry.amount])).toEqual([
      [TRADER, 100_000_000n],
      ['0x00000000000000000000000000000000000000bb', 200_000_000n],
    ]);
  });

  it('ignores a curve the Pons factory never launched, whatever its events say', async () => {
    const IMPOSTOR: Hex = '0x00000000000000000000000000000000000000c2';
    const chain = fakeChain([
      // The same launch event, from a contract that is not the factory.
      launched(20, IMPOSTOR, IMPOSTOR),
      { ...curveBuy(5n * 10n ** 18n, TRADER, 600), address: IMPOSTOR },
    ]);
    const market = indexer(chain.rpc);
    await market.start();

    expect(market.ponsActivity('NVDA', all)).toEqual([]);
  });

  it('follows the chain after the backfill, including a pool created since', async () => {
    const logs: RawLog[] = [];
    const chain = fakeChain(logs);
    const market = indexer(chain.rpc);
    await market.start();

    logs.push(initialize(1_005), swap(USDG_POOL, 100_000_000n, -(5n * 10n ** 17n), 1_010));
    chain.head.value = 1_020;
    expect(await market.poll()).toBe(true);

    expect(market.trades('NVDA', all)).toHaveLength(1);
    expect(market.coversUntil()).toBe(blockTime(1_020));
  });

  it('finds where its retention starts in a handful of reads, reading nothing older', async () => {
    const head = 1_000_000;
    const chain = fakeChain([
      initialize(10),
      // Ten minutes before the head is block 999_400: one trade well before it, one after.
      swap(USDG_POOL, 300_000_000n, -(10n ** 18n), 999_000),
      swap(USDG_POOL, 210_000_000n, -(10n ** 18n), 999_450),
    ]);
    chain.head.value = head;
    let timestampReads = 0;
    const rpc: MarketRpc = {
      ...chain.rpc,
      blockTimestamp: (block) => {
        timestampReads += 1;
        return chain.rpc.blockTimestamp(block);
      },
    };
    const market = new RobinhoodMarketIndexer({
      rpc,
      addresses: MARKET,
      tradeRetentionMs: 600_000,
      volumeRetentionMs: 600_000,
      minTradeQuote: 1_000_000n,
      ponsRetentionMs: 600_000,
      maxBlocksPerPoll: 10_000n,
      referenceRefreshMs: 60_000,
      now: () => blockTime(head),
    });
    await market.start();

    expect(market.notional('NVDA', all)).toBe(210_000_000n);
    expect(market.trades('NVDA', all)).toHaveLength(1);
    // The head, and genesis plus one probe for each of the three searches.
    expect(timestampReads).toBeLessThanOrEqual(10);
  });

  it('refuses to start on a token that is not the ticker it is registered as', async () => {
    const chain = fakeChain([], { [TOKEN]: 'NVDAX' });
    await expect(indexer(chain.rpc).start()).rejects.toThrow('reports symbol "NVDAX"');
  });

  it('is behind the chain until it has started', () => {
    const market = indexer(fakeChain([]).rpc);
    expect(market.coversUntil()).toBe(0);
    expect(market.trades('NVDA', all)).toEqual([]);
  });
});
