import { decodeEventLog, parseAbi, toEventSelector, type Hex } from 'viem';
import type { RawLog } from './log-scan.js';

/**
 * The events a market is read from, decoded (§75.1, §75.2).
 *
 * Five events from three contracts, and nothing else:
 *
 * - Uniswap v4 `PoolManager`: `Initialize` names a pool's two currencies and
 *   hook; `Swap` is a trade in it.
 * - Pons V2 factory: `TokenLaunched` names a launch's bonding curve and the
 *   asset it is quoted in.
 * - Pons V2 bonding curve: `CurveBuy` and `CurveSell` are trades on it.
 * - Pons V2 hook: `PoolRegistered` names a graduated pool and its quote asset.
 *
 * The signatures are the verified sources' own. Decoding is strict: a log that
 * does not decode as the event its topic claims is an error, never a guess.
 */

export const MARKET_EVENTS_ABI = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)',
]);

/** Topic 0 of each event, for filters. */
export const MARKET_TOPICS = {
  initialize: toEventSelector(MARKET_EVENTS_ABI[0]),
  swap: toEventSelector(MARKET_EVENTS_ABI[1]),
  tokenLaunched: toEventSelector(MARKET_EVENTS_ABI[2]),
  curveBuy: toEventSelector(MARKET_EVENTS_ABI[3]),
  curveSell: toEventSelector(MARKET_EVENTS_ABI[4]),
  poolRegistered: toEventSelector(MARKET_EVENTS_ABI[5]),
} as const;

/** Where a log sits, for identity and time. */
export interface LogPosition {
  /** Transaction hash and log index: unique and stable across re-reads. */
  readonly eventId: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  /**
   * Milliseconds; `null` if the endpoint did not date the log. The public
   * Robinhood Chain endpoint sends `blockTimestamp: 0x0`, which is no date.
   */
  readonly at: number | null;
}

export type MarketEvent =
  | {
      readonly kind: 'POOL_INITIALIZED';
      readonly poolId: string;
      readonly currency0: string;
      readonly currency1: string;
      readonly hooks: string;
    }
  | {
      readonly kind: 'SWAP';
      readonly poolId: string;
      readonly sender: string;
      readonly amount0: bigint;
      readonly amount1: bigint;
    }
  | {
      readonly kind: 'TOKEN_LAUNCHED';
      readonly token: string;
      readonly curve: string;
      readonly pairToken: string;
    }
  | {
      readonly kind: 'CURVE_TRADE';
      readonly curve: string;
      /** Who received what the trade produced: the trader, not a router. */
      readonly trader: string;
      /** The quote side of the trade, in the quote asset's base units. */
      readonly quoteAmount: bigint;
    }
  | {
      readonly kind: 'POOL_REGISTERED';
      readonly poolId: string;
      readonly memecoin: string;
      readonly quoteToken: string;
    };

export function logPosition(log: RawLog): LogPosition {
  return {
    eventId: `${log.transactionHash.toLowerCase()}:${String(Number(BigInt(log.logIndex)))}`,
    transactionHash: log.transactionHash.toLowerCase(),
    blockNumber: Number(BigInt(log.blockNumber)),
    at:
      log.blockTimestamp === undefined || BigInt(log.blockTimestamp) === 0n
        ? null
        : Number(BigInt(log.blockTimestamp)) * 1_000,
  };
}

const lower = (value: string): string => value.toLowerCase();

/**
 * Decodes one of the five events.
 *
 * @throws Error when the log's topic is none of them, or its data does not
 *   decode as the event the topic names.
 */
export function decodeMarketEvent(log: RawLog): MarketEvent {
  const decoded = decodeEventLog({
    abi: MARKET_EVENTS_ABI,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data as Hex,
    strict: true,
  });
  switch (decoded.eventName) {
    case 'Initialize':
      return {
        kind: 'POOL_INITIALIZED',
        poolId: lower(decoded.args.id),
        currency0: lower(decoded.args.currency0),
        currency1: lower(decoded.args.currency1),
        hooks: lower(decoded.args.hooks),
      };
    case 'Swap':
      return {
        kind: 'SWAP',
        poolId: lower(decoded.args.id),
        sender: lower(decoded.args.sender),
        amount0: decoded.args.amount0,
        amount1: decoded.args.amount1,
      };
    case 'TokenLaunched':
      return {
        kind: 'TOKEN_LAUNCHED',
        token: lower(decoded.args.token),
        curve: lower(decoded.args.curve),
        pairToken: lower(decoded.args.pairToken),
      };
    case 'CurveBuy':
      return {
        kind: 'CURVE_TRADE',
        curve: lower(log.address),
        trader: lower(decoded.args.recipient),
        quoteAmount: decoded.args.quoteIn,
      };
    case 'CurveSell':
      return {
        kind: 'CURVE_TRADE',
        curve: lower(log.address),
        trader: lower(decoded.args.recipient),
        quoteAmount: decoded.args.quoteOut,
      };
    case 'PoolRegistered':
      return {
        kind: 'POOL_REGISTERED',
        poolId: lower(decoded.args.poolId),
        memecoin: lower(decoded.args.memecoin),
        quoteToken: lower(decoded.args.quoteToken),
      };
  }
}
