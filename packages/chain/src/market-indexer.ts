import type {
  MarketSource,
  DexTrade,
  ReferencePrice,
  Span,
  TradeUnits,
} from '@ponswars/market-data';
import type { NormalizedActivity } from '@ponswars/pons-indexer';
import {
  ACTIVE_TICKERS,
  utcTimestamp,
  walletAddress,
  type ActiveTicker,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { scanLogs, type LogFilter, type RawLog, type RpcRequest } from './log-scan.js';
import {
  decodeMarketEvent,
  logPosition,
  MARKET_TOPICS,
  type MarketEvent,
} from './market-events.js';
import type { RobinhoodMarketAddresses } from './robinhood-market.js';

/**
 * Robinhood Chain, read as a market (§23.2–§23.4, §75).
 *
 * Keeps, in memory, what a battle needs to know about the ten Stock Tokens:
 *
 * - their trades against USDG in every Uniswap v4 pool that pairs the two;
 * - Pons trading quoted in them — bonding-curve buys and sells, and swaps in the
 *   graduated pools Pons' hook registers;
 * - the Chainlink reference price for each.
 *
 * It starts by discovering the pools from the whole of history, then backfills
 * the trading it is asked to retain, then follows the chain block by block.
 * Bonding curves are not discovered up front — Pons has launched tens of
 * thousands, nearly all quoted in ETH — but asked about the first time one
 * trades: its own `factory()` and `pairToken()` say whether it is a Pons curve
 * quoted in a Stock Token. Until the backfill is done `coversUntil` stays behind, and the market
 * reads `UNAVAILABLE` rather than mistaking a history it has not read for a
 * quiet one.
 *
 * Everything is re-derivable from logs: nothing here is a source of truth, and
 * a restart rebuilds the same state from the same chain.
 */

/** The reads the indexer makes, beyond logs. */
export interface MarketRpc {
  readonly request: RpcRequest;
  blockNumber(): Promise<bigint>;
  /** Milliseconds. */
  blockTimestamp(block: bigint): Promise<number>;
  /** The externally owned account that sent a transaction. */
  transactionSender(hash: string): Promise<string>;
  hasCode(address: string): Promise<boolean>;
  tokenSymbol(address: string): Promise<string>;
  tokenDecimals(address: string): Promise<number>;
  feedDescription(address: string): Promise<string>;
  feedDecimals(address: string): Promise<number>;
  /** The feed's latest answer at its own decimals, and when it updated (ms). */
  feedLatest(address: string): Promise<{ readonly answer: bigint; readonly updatedAt: number }>;
  /**
   * Which factory made each contract and what it is quoted in, where the
   * contract answers as a Pons bonding curve; `null` where it does not.
   */
  curveOrigins(
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly factory: string; readonly pairToken: string } | null>>;
}

export interface MarketIndexerOptions {
  readonly rpc: MarketRpc;
  readonly addresses: RobinhoodMarketAddresses;
  /** How much DEX trading is kept: the volatility lookback and the comparable days. */
  readonly tradeRetentionMs: number;
  /** How much Pons activity is kept: a battle and the confidence lookback before it. */
  readonly ponsRetentionMs: number;
  /** The widest block range one poll reads. */
  readonly maxBlocksPerPoll: bigint;
  /** How often the reference prices are re-read. */
  readonly referenceRefreshMs: number;
  readonly now: () => number;
  readonly onLog?: (message: string) => void;
}

/** Pool ids a single `eth_getLogs` topic OR-list carries. */
const IDS_PER_QUERY = 200;

const PRICE_DECIMALS = 8;

interface PoolSide {
  readonly ticker: ActiveTicker;
  /** Whether the ticker's side is `currency0`. */
  readonly tickerIs0: boolean;
}

interface PonsTrade {
  readonly eventId: string;
  readonly transactionHash: string;
  readonly wallet: string | null;
  readonly blockNumber: number;
  readonly at: UtcTimestamp;
  /** In the ticker's token base units. */
  readonly tokenAmount: bigint;
}

export class RobinhoodMarketIndexer implements MarketSource {
  private readonly tickerOf = new Map<string, ActiveTicker>();
  private readonly usdgPools = new Map<string, PoolSide>();
  private readonly ponsPools = new Map<string, PoolSide>();
  private readonly curves = new Map<string, ActiveTicker>();
  /** Contracts already asked about that are not curves quoted in a ticker. */
  private readonly notCurves = new Set<string>();
  /** Curve trades seen before their curve was asked about. */
  private pendingCurveTrades: {
    readonly event: Extract<MarketEvent, { kind: 'CURVE_TRADE' }>;
    readonly eventId: string;
    readonly transactionHash: string;
    readonly blockNumber: number;
    readonly atMs: number;
  }[] = [];
  private readonly dexTrades = new Map<ActiveTicker, DexTrade[]>();
  private readonly ponsTrades = new Map<ActiveTicker, PonsTrade[]>();
  private readonly seen = new Set<string>();
  private readonly senders = new Map<string, string>();
  private readonly references = new Map<ActiveTicker, ReferencePrice>();
  private readonly routers: ReadonlySet<string>;
  private readonly tokenDecimals = new Map<ActiveTicker, number>();
  private usdgDecimals = 6;
  private readonly feedScale = new Map<ActiveTicker, number>();
  private lastBlock = -1n;
  private covered = utcTimestamp(0);
  private referencesReadAt = 0;

  constructor(private readonly options: MarketIndexerOptions) {
    for (const ticker of ACTIVE_TICKERS) {
      this.tickerOf.set(options.addresses.tickers[ticker].token.toLowerCase(), ticker);
      this.dexTrades.set(ticker, []);
      this.ponsTrades.set(ticker, []);
    }
    this.routers = new Set(options.addresses.routers.map((router) => router.toLowerCase()));
  }

  // --- MarketSource -------------------------------------------------------

  trades(ticker: ActiveTicker, span: Span): readonly DexTrade[] {
    return between(this.dexTrades.get(ticker) ?? [], span);
  }

  ponsActivity(ticker: ActiveTicker, span: Span): readonly NormalizedActivity[] {
    const reference = this.references.get(ticker);
    if (reference === undefined) {
      // No price to size the trades by: nothing is qualified rather than
      // everything being sized as zero and counted as dust.
      return [];
    }
    const decimals = this.tokenDecimals.get(ticker) ?? 18;
    return between(this.ponsTrades.get(ticker) ?? [], span).flatMap((trade) =>
      trade.wallet === null
        ? []
        : [
            {
              eventId: trade.eventId,
              wallet: walletAddress(trade.wallet),
              ticker,
              // Token amount × USD price, in USDG base units.
              amount:
                (trade.tokenAmount * reference.price * 10n ** BigInt(this.usdgDecimals)) /
                (10n ** BigInt(decimals) * 10n ** BigInt(PRICE_DECIMALS)),
              blockNumber: trade.blockNumber,
              at: trade.at,
            },
          ],
    );
  }

  reference(ticker: ActiveTicker): ReferencePrice | null {
    return this.references.get(ticker) ?? null;
  }

  units(ticker: ActiveTicker): TradeUnits {
    return {
      quoteDecimals: this.usdgDecimals,
      tokenDecimals: this.tokenDecimals.get(ticker) ?? 18,
    };
  }

  coversUntil(): UtcTimestamp {
    return this.covered;
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Checks every address, discovers pools and curves, and backfills.
   *
   * @throws Error when an address is not what the registry says it is — a
   *   token whose symbol is not its ticker, a feed that does not name it.
   */
  async start(): Promise<void> {
    const { rpc, addresses } = this.options;
    await this.verify();

    const head = await rpc.blockNumber();
    const headAt = await rpc.blockTimestamp(head);
    const tradesFrom = await this.blockAtOrBefore(
      head,
      headAt,
      headAt - this.options.tradeRetentionMs,
    );
    const ponsFrom = await this.blockAtOrBefore(
      head,
      headAt,
      headAt - this.options.ponsRetentionMs,
    );
    this.say(
      `market: head ${head.toString()}, trades from ${tradesFrom.toString()}, Pons from ${ponsFrom.toString()}`,
    );

    // Discovery reads all of history: a pool or curve created a year ago still trades.
    for (const ticker of ACTIVE_TICKERS) {
      const token = addresses.tickers[ticker].token.toLowerCase();
      const usdg = addresses.usdg.toLowerCase();
      const [currency0, currency1] = token < usdg ? [token, usdg] : [usdg, token];
      const logs = await this.scan(
        {
          address: addresses.poolManager,
          topics: [MARKET_TOPICS.initialize, null, pad(currency0), pad(currency1)],
        },
        0n,
        head,
      );
      this.apply(logs);
    }
    this.apply(
      await this.scan(
        { address: addresses.ponsMemeHook, topics: [MARKET_TOPICS.poolRegistered] },
        0n,
        head,
      ),
    );
    this.say(
      `market: ${String(this.usdgPools.size)} USDG pools, ${String(this.ponsPools.size)} Pons pools`,
    );

    await this.readTrades(tradesFrom, head, ponsFrom);
    await this.refreshReferences(true);
    this.lastBlock = head;
    this.covered = utcTimestamp(headAt);
    this.prune();
  }

  /** Reads everything since the last poll. Returns whether it reached the head. */
  async poll(): Promise<boolean> {
    const { rpc, addresses, maxBlocksPerPoll } = this.options;
    const head = await rpc.blockNumber();
    if (head <= this.lastBlock) {
      await this.refreshReferences(false);
      return true;
    }
    const from = this.lastBlock + 1n;
    const to = head - from + 1n > maxBlocksPerPoll ? from + maxBlocksPerPoll - 1n : head;

    const tokens = ACTIVE_TICKERS.map((ticker) =>
      pad(addresses.tickers[ticker].token.toLowerCase()),
    );
    const quotes = [...tokens, pad(addresses.usdg.toLowerCase())];
    // New pools first, so a swap in a pool created in this same range is kept.
    this.apply(
      await this.scan(
        {
          address: addresses.poolManager,
          topics: [MARKET_TOPICS.initialize, null, quotes, quotes],
        },
        from,
        to,
      ),
    );
    this.apply(
      await this.scan(
        { address: addresses.ponsMemeHook, topics: [MARKET_TOPICS.poolRegistered] },
        from,
        to,
      ),
    );
    await this.readTrades(from, to, from);

    const toAt = await rpc.blockTimestamp(to);
    this.lastBlock = to;
    this.covered = utcTimestamp(toAt);
    await this.refreshReferences(false);
    this.prune();
    return to === head;
  }

  // --- Internals ----------------------------------------------------------

  private async verify(): Promise<void> {
    const { rpc, addresses } = this.options;
    for (const [label, address] of [
      ['PoolManager', addresses.poolManager],
      ['USDG', addresses.usdg],
      ['Pons factory', addresses.ponsFactory],
      ['Pons hook', addresses.ponsMemeHook],
    ] as const) {
      if (!(await rpc.hasCode(address))) {
        throw new Error(`${label} at ${address} has no code on this chain`);
      }
    }
    this.usdgDecimals = await rpc.tokenDecimals(addresses.usdg);
    for (const ticker of ACTIVE_TICKERS) {
      const { token, referenceFeed } = addresses.tickers[ticker];
      const symbol = await rpc.tokenSymbol(token);
      if (symbol !== ticker) {
        throw new Error(`The ${ticker} Stock Token at ${token} reports symbol "${symbol}"`);
      }
      this.tokenDecimals.set(ticker, await rpc.tokenDecimals(token));
      const description = await rpc.feedDescription(referenceFeed);
      if (!description.toUpperCase().includes(ticker)) {
        throw new Error(`The ${ticker} reference feed at ${referenceFeed} is "${description}"`);
      }
      this.feedScale.set(ticker, await rpc.feedDecimals(referenceFeed));
    }
  }

  /** DEX swaps and Pons trading in `[from, to]`; Pons only from `ponsFrom`. */
  private async readTrades(from: bigint, to: bigint, ponsFrom: bigint): Promise<void> {
    const { addresses } = this.options;
    const usdgIds = [...this.usdgPools.keys()];
    for (let index = 0; index < usdgIds.length; index += IDS_PER_QUERY) {
      const ids = usdgIds.slice(index, index + IDS_PER_QUERY);
      this.apply(
        await this.scan(
          { address: addresses.poolManager, topics: [MARKET_TOPICS.swap, ids] },
          from,
          to,
        ),
      );
    }
    if (ponsFrom > to) {
      return;
    }
    const ponsStart = ponsFrom > from ? ponsFrom : from;
    const ponsIds = [...this.ponsPools.keys()];
    for (let index = 0; index < ponsIds.length; index += IDS_PER_QUERY) {
      const ids = ponsIds.slice(index, index + IDS_PER_QUERY);
      this.apply(
        await this.scan(
          { address: addresses.poolManager, topics: [MARKET_TOPICS.swap, ids] },
          ponsStart,
          to,
        ),
      );
    }
    // Curve trades chain-wide, kept for the curves quoted in a ticker.
    this.apply(
      await this.scan(
        { topics: [[MARKET_TOPICS.curveBuy, MARKET_TOPICS.curveSell]] },
        ponsStart,
        to,
      ),
    );
    await this.resolveCurves();
    await this.resolveSenders();
  }

  private async scan(filter: LogFilter, from: bigint, to: bigint): Promise<RawLog[]> {
    const logs = await scanLogs(this.options.rpc.request, filter, from, to);
    // Endpoints that do not date their logs get dated here, one lookup per block.
    const dated: RawLog[] = [];
    const stamps = new Map<string, string>();
    for (const log of logs) {
      if (log.blockTimestamp !== undefined) {
        dated.push(log);
        continue;
      }
      let stamp = stamps.get(log.blockNumber);
      if (stamp === undefined) {
        const ms = await this.options.rpc.blockTimestamp(BigInt(log.blockNumber));
        stamp = `0x${Math.floor(ms / 1_000).toString(16)}`;
        stamps.set(log.blockNumber, stamp);
      }
      dated.push({ ...log, blockTimestamp: stamp });
    }
    return dated;
  }

  private apply(logs: readonly RawLog[]): void {
    for (const log of logs) {
      const position = logPosition(log);
      if (this.seen.has(position.eventId)) {
        continue;
      }
      let event: MarketEvent;
      try {
        event = decodeMarketEvent(log);
      } catch {
        // A different event sharing a topic filter; not ours.
        continue;
      }
      this.seen.add(position.eventId);
      this.record(
        event,
        position.eventId,
        position.transactionHash,
        position.blockNumber,
        position.at ?? 0,
      );
    }
  }

  private record(
    event: MarketEvent,
    eventId: string,
    transactionHash: string,
    blockNumber: number,
    atMs: number,
  ): void {
    const { addresses } = this.options;
    const usdg = addresses.usdg.toLowerCase();
    const at = utcTimestamp(atMs);
    switch (event.kind) {
      case 'POOL_INITIALIZED': {
        const ticker0 = this.tickerOf.get(event.currency0);
        const ticker1 = this.tickerOf.get(event.currency1);
        if (ticker1 !== undefined && event.currency0 === usdg) {
          this.usdgPools.set(event.poolId, { ticker: ticker1, tickerIs0: false });
        } else if (ticker0 !== undefined && event.currency1 === usdg) {
          this.usdgPools.set(event.poolId, { ticker: ticker0, tickerIs0: true });
        }
        return;
      }
      case 'TOKEN_LAUNCHED': {
        const ticker = this.tickerOf.get(event.pairToken);
        if (ticker !== undefined) {
          this.curves.set(event.curve, ticker);
        }
        return;
      }
      case 'POOL_REGISTERED': {
        const ticker = this.tickerOf.get(event.quoteToken);
        if (ticker !== undefined) {
          // v4 orders currencies by address.
          this.ponsPools.set(event.poolId, {
            ticker,
            tickerIs0: event.quoteToken < event.memecoin,
          });
        }
        return;
      }
      case 'SWAP': {
        const usdgPool = this.usdgPools.get(event.poolId);
        if (usdgPool !== undefined) {
          const tokenAmount = abs(usdgPool.tickerIs0 ? event.amount0 : event.amount1);
          const quoteAmount = abs(usdgPool.tickerIs0 ? event.amount1 : event.amount0);
          if (tokenAmount > 0n) {
            insertByTime(this.dexTrades.get(usdgPool.ticker), {
              eventId,
              poolId: event.poolId,
              blockNumber,
              at,
              quoteAmount,
              tokenAmount,
            });
          }
          return;
        }
        const ponsPool = this.ponsPools.get(event.poolId);
        if (ponsPool !== undefined) {
          insertByTime(this.ponsTrades.get(ponsPool.ticker), {
            eventId,
            transactionHash,
            // A v4 swap's `sender` is the router; the trader is resolved from
            // the transaction afterwards.
            wallet: null,
            blockNumber,
            at,
            tokenAmount: abs(ponsPool.tickerIs0 ? event.amount0 : event.amount1),
          });
        }
        return;
      }
      case 'CURVE_TRADE': {
        const ticker = this.curves.get(event.curve);
        if (ticker === undefined && !this.notCurves.has(event.curve)) {
          this.pendingCurveTrades.push({ event, eventId, transactionHash, blockNumber, atMs });
          return;
        }
        if (ticker !== undefined) {
          insertByTime(this.ponsTrades.get(ticker), {
            eventId,
            transactionHash,
            wallet: this.routers.has(event.trader) ? null : event.trader,
            blockNumber,
            at,
            tokenAmount: event.quoteAmount,
          });
        }
        return;
      }
    }
  }

  /**
   * Asks every contract seen trading as a curve what it is, then records the
   * trades that were waiting on the answer.
   *
   * Only a curve made by the Pons V2 factory counts: anything can emit an event
   * with the same signature, and one that did would otherwise buy Pons Power.
   */
  private async resolveCurves(): Promise<void> {
    if (this.pendingCurveTrades.length === 0) {
      return;
    }
    const factory = this.options.addresses.ponsFactory.toLowerCase();
    const unknown = [
      ...new Set(
        this.pendingCurveTrades
          .map(({ event }) => event.curve)
          .filter((curve) => !this.curves.has(curve) && !this.notCurves.has(curve)),
      ),
    ];
    const origins = await this.options.rpc.curveOrigins(unknown);
    for (const curve of unknown) {
      const origin = origins.get(curve) ?? null;
      const ticker =
        origin !== null && origin.factory.toLowerCase() === factory
          ? this.tickerOf.get(origin.pairToken.toLowerCase())
          : undefined;
      if (ticker === undefined) {
        this.notCurves.add(curve);
      } else {
        this.curves.set(curve, ticker);
      }
    }
    const pending = this.pendingCurveTrades;
    this.pendingCurveTrades = [];
    for (const trade of pending) {
      this.record(trade.event, trade.eventId, trade.transactionHash, trade.blockNumber, trade.atMs);
    }
  }

  /** Fills in the trader behind each Pons pool swap and each routed curve trade. */
  private async resolveSenders(): Promise<void> {
    for (const ticker of ACTIVE_TICKERS) {
      const list = this.ponsTrades.get(ticker) ?? [];
      for (let index = 0; index < list.length; index += 1) {
        const trade = list[index];
        if (trade?.wallet !== null) {
          continue;
        }
        let sender = this.senders.get(trade.transactionHash);
        if (sender === undefined) {
          sender = (await this.options.rpc.transactionSender(trade.transactionHash)).toLowerCase();
          this.senders.set(trade.transactionHash, sender);
        }
        list[index] = { ...trade, wallet: sender };
      }
    }
  }

  private async refreshReferences(force: boolean): Promise<void> {
    const now = this.options.now();
    if (!force && now - this.referencesReadAt < this.options.referenceRefreshMs) {
      return;
    }
    for (const ticker of ACTIVE_TICKERS) {
      const feed = this.options.addresses.tickers[ticker].referenceFeed;
      const latest = await this.options.rpc.feedLatest(feed);
      const decimals = this.feedScale.get(ticker) ?? PRICE_DECIMALS;
      const price =
        decimals >= PRICE_DECIMALS
          ? latest.answer / 10n ** BigInt(decimals - PRICE_DECIMALS)
          : latest.answer * 10n ** BigInt(PRICE_DECIMALS - decimals);
      if (price > 0n) {
        this.references.set(ticker, { price, updatedAt: utcTimestamp(latest.updatedAt) });
      }
    }
    this.referencesReadAt = now;
  }

  /** The newest block at or before `targetMs`, by bisection on timestamps. */
  private async blockAtOrBefore(head: bigint, headAt: number, targetMs: number): Promise<bigint> {
    if (targetMs >= headAt) {
      return head;
    }
    let low = 0n;
    let high = head;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if ((await this.options.rpc.blockTimestamp(middle)) <= targetMs) {
        low = middle;
      } else {
        high = middle - 1n;
      }
    }
    return low;
  }

  private prune(): void {
    const now = this.covered;
    for (const ticker of ACTIVE_TICKERS) {
      dropBefore(this.dexTrades.get(ticker), now - this.options.tradeRetentionMs);
      dropBefore(this.ponsTrades.get(ticker), now - this.options.ponsRetentionMs);
    }
    // Event ids only need remembering as long as a re-read could return them.
    if (this.seen.size > 2_000_000) {
      this.seen.clear();
    }
    if (this.senders.size > 200_000) {
      this.senders.clear();
    }
    if (this.notCurves.size > 500_000) {
      this.notCurves.clear();
    }
  }

  private say(message: string): void {
    this.options.onLog?.(message);
  }
}

function pad(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Inserts keeping the list ordered by time; appends in the common case. */
function insertByTime<T extends { readonly at: number }>(list: T[] | undefined, entry: T): void {
  if (list === undefined) {
    return;
  }
  let index = list.length;
  while (index > 0 && (list[index - 1]?.at ?? 0) > entry.at) {
    index -= 1;
  }
  list.splice(index, 0, entry);
}

/** The entries inside `[from, to)` of a time-ordered list. */
function between<T extends { readonly at: number }>(list: readonly T[], span: Span): T[] {
  const start = lowerBound(list, span.from);
  const end = lowerBound(list, span.to);
  return list.slice(start, end);
}

/** Timed entries, by the one field that orders them. */
interface Timed {
  readonly at: number;
}

function lowerBound(list: readonly Timed[], at: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((list[middle]?.at ?? 0) < at) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function dropBefore(list: Timed[] | undefined, cutoff: number): void {
  if (list === undefined) {
    return;
  }
  const count = lowerBound(list, cutoff);
  if (count > 0) {
    list.splice(0, count);
  }
}
