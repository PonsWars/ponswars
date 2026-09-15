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
import { BlockClock } from './block-clock.js';
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
 * thousands, nearly all quoted in ETH — but looked up the first time one
 * trades: the Pons factory's own `TokenLaunched` for it says whether it is a
 * Pons curve and what it is quoted in. Until the backfill is done `coversUntil` stays behind, and the market
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
  /**
   * The externally owned account that sent each transaction, by hash.
   *
   * Many at once: a busy Pons pool produces a swap a second, and a request per
   * transaction behind a paced endpoint was most of a backfill's time.
   */
  transactionSenders(hashes: readonly string[]): Promise<ReadonlyMap<string, string>>;
  hasCode(address: string): Promise<boolean>;
  tokenSymbol(address: string): Promise<string>;
  tokenDecimals(address: string): Promise<number>;
  feedDescription(address: string): Promise<string>;
  feedDecimals(address: string): Promise<number>;
  /** The feed's latest answer at its own decimals, and when it updated (ms). */
  feedLatest(address: string): Promise<{ readonly answer: bigint; readonly updatedAt: number }>;
}

export interface MarketIndexerOptions {
  readonly rpc: MarketRpc;
  readonly addresses: RobinhoodMarketAddresses;
  /** How long DEX trades themselves are kept: the price window and the volatility lookback. */
  readonly tradeRetentionMs: number;
  /**
   * How long per-minute dollar volume is kept: every comparable earlier trading
   * day relative volume looks back to (§12.2). Days, where trades are hours.
   */
  readonly volumeRetentionMs: number;
  /** Smallest trade counted towards volume, in the dollar token's base units. */
  readonly minTradeQuote: bigint;
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

/** Every event a poll reads, in one query. */
const POLL_TOPICS = [
  MARKET_TOPICS.initialize,
  MARKET_TOPICS.poolRegistered,
  MARKET_TOPICS.swap,
  MARKET_TOPICS.curveBuy,
  MARKET_TOPICS.curveSell,
];

/** The events that create somewhere to trade, applied before the trades beside them. */
const POOL_TOPICS: ReadonlySet<string> = new Set(
  [MARKET_TOPICS.initialize, MARKET_TOPICS.poolRegistered].map((topic) => topic.toLowerCase()),
);

/** Curve addresses looked up in one `TokenLaunched` query. */
const CURVES_PER_QUERY = 100;

const PRICE_DECIMALS = 8;

const MINUTE = 60_000;

/**
 * Block-time anchor spacing where a second matters: about five minutes of
 * Robinhood Chain, measured to interpolate within a second.
 */
const FINE_ANCHOR_BLOCKS = 3_000n;

/** Anchor spacing for volume history, which is bucketed by the minute: about fifty minutes. */
const COARSE_ANCHOR_BLOCKS = 30_000n;

/** How far before its target a block search may stop: a minute of extra blocks to read. */
const BLOCK_SEARCH_TOLERANCE_MS = MINUTE;

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
  /** Dollar volume per whole minute (epoch minutes), per ticker. */
  private readonly minuteVolume = new Map<ActiveTicker, Map<number, bigint>>();
  /** Trades older than this are counted into volume but not kept. */
  private keepTradesFrom = 0;
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
  /** Block timestamps, read at anchors and interpolated between them. */
  private readonly clock: BlockClock;
  /** From here on, trades are dated from close anchors; before it, volume only needs the minute. */
  private fineFromBlock = 0n;

  constructor(private readonly options: MarketIndexerOptions) {
    this.clock = new BlockClock((block) => options.rpc.blockTimestamp(block));
    for (const ticker of ACTIVE_TICKERS) {
      this.tickerOf.set(options.addresses.tickers[ticker].token.toLowerCase(), ticker);
      this.dexTrades.set(ticker, []);
      this.minuteVolume.set(ticker, new Map());
      this.ponsTrades.set(ticker, []);
    }
    this.routers = new Set(options.addresses.routers.map((router) => router.toLowerCase()));
  }

  // --- MarketSource -------------------------------------------------------

  trades(ticker: ActiveTicker, span: Span): readonly DexTrade[] {
    return between(this.dexTrades.get(ticker) ?? [], span);
  }

  notional(ticker: ActiveTicker, span: Span): bigint {
    const minutes = this.minuteVolume.get(ticker);
    if (minutes === undefined) {
      return 0n;
    }
    // Whole minutes starting inside the span. Walked over whichever is shorter —
    // the span or what is kept — so a wide span costs no more than the history.
    const first = Math.ceil(span.from / MINUTE);
    const end = Math.ceil(span.to / MINUTE);
    let total = 0n;
    if (end - first <= minutes.size) {
      for (let minute = first; minute < end; minute += 1) {
        total += minutes.get(minute) ?? 0n;
      }
    } else {
      for (const [minute, value] of minutes) {
        if (minute >= first && minute < end) {
          total += value;
        }
      }
    }
    return total;
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
    const headAt = await this.clock.read(head);
    this.keepTradesFrom = headAt - this.options.tradeRetentionMs;
    const volumeFrom = await this.blockAtOrBefore(
      head,
      headAt,
      headAt - Math.max(this.options.volumeRetentionMs, this.options.tradeRetentionMs),
    );
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
    this.fineFromBlock = tradesFrom < ponsFrom ? tradesFrom : ponsFrom;
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

    this.say(
      `market: volume from block ${volumeFrom.toString()}, trades kept from ${tradesFrom.toString()}`,
    );
    await this.readTrades(volumeFrom, head, ponsFrom);
    await this.refreshReferences(true);
    this.lastBlock = head;
    this.covered = utcTimestamp(headAt);
    this.prune();
  }

  /** Reads everything since the last poll. Returns whether it reached the head. */
  async poll(): Promise<boolean> {
    const { rpc, maxBlocksPerPoll } = this.options;
    const head = await rpc.blockNumber();
    if (head <= this.lastBlock) {
      await this.refreshReferences(false);
      return true;
    }
    const from = this.lastBlock + 1n;
    const to = head - from + 1n > maxBlocksPerPoll ? from + maxBlocksPerPoll - 1n : head;

    // Before the logs, so every block in the range lies between two anchors.
    const toAt = await this.clock.read(to);
    // One read for everything a market is made of, sorted out here. A query
    // per batch of pool ids was most of a poll's calls, and a poll that takes
    // longer than the chain takes to make its blocks never catches up. What
    // came from the wrong contract is dropped by `apply`.
    const logs = await this.scanTrades({ topics: [POLL_TOPICS] }, from, to);
    // New pools first, so a trade in a pool created in this same range is kept.
    const creates = (log: RawLog): boolean => POOL_TOPICS.has(log.topics[0]?.toLowerCase() ?? '');
    this.apply(logs.filter(creates));
    this.apply(logs.filter((log) => !creates(log)));
    await this.resolveCurves(to);
    await this.resolveSenders();

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
        await this.scanTrades(
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
        await this.scanTrades(
          { address: addresses.poolManager, topics: [MARKET_TOPICS.swap, ids] },
          ponsStart,
          to,
        ),
      );
    }
    // Curve trades chain-wide, kept for the curves quoted in a ticker.
    this.apply(
      await this.scanTrades(
        { topics: [[MARKET_TOPICS.curveBuy, MARKET_TOPICS.curveSell]] },
        ponsStart,
        to,
      ),
    );
    await this.resolveCurves(to);
    await this.resolveSenders();
  }

  /** Logs whose time does not matter: pools and registrations. */
  private scan(filter: LogFilter, from: bigint, to: bigint): Promise<RawLog[]> {
    return scanLogs(this.options.rpc.request, filter, from, to);
  }

  /**
   * Trade logs, each with its block's time.
   *
   * An endpoint that dates its logs is believed. One that does not — the public
   * Robinhood Chain endpoint sends `0x0` — has its blocks placed by the clock:
   * anchors a few minutes apart where a price or a Pons window will be read,
   * and further apart before that, where only a minute of volume is.
   */
  private async scanTrades(filter: LogFilter, from: bigint, to: bigint): Promise<RawLog[]> {
    const logs = await this.scan(filter, from, to);
    const undated = logs.filter((log) => logPosition(log).at === null);
    if (undated.length === 0) {
      return logs;
    }
    const times = await this.clock.timesOf(
      undated.map((log) => BigInt(log.blockNumber)),
      (block) => (block >= this.fineFromBlock ? FINE_ANCHOR_BLOCKS : COARSE_ANCHOR_BLOCKS),
    );
    return logs.map((log) => {
      if (logPosition(log).at !== null) {
        return log;
      }
      const at = times.get(BigInt(log.blockNumber));
      if (at === undefined) {
        throw new Error(`market: no time for block ${log.blockNumber}`);
      }
      return { ...log, blockTimestamp: `0x${Math.floor(at / 1_000).toString(16)}` };
    });
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
      if (!this.emittedBy(event, log.address)) {
        // The right signature from the wrong contract: a forgery, or a
        // lookalike. Either way it says nothing about this market.
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

  /** Whether a log came from the contract that event is trusted from. */
  private emittedBy(event: MarketEvent, address: string): boolean {
    const { addresses } = this.options;
    const emitter = address.toLowerCase();
    switch (event.kind) {
      case 'POOL_INITIALIZED':
      case 'SWAP':
        return emitter === addresses.poolManager.toLowerCase();
      case 'TOKEN_LAUNCHED':
        return emitter === addresses.ponsFactory.toLowerCase();
      case 'POOL_REGISTERED':
        return emitter === addresses.ponsMemeHook.toLowerCase();
      case 'CURVE_TRADE':
        // Any contract; `resolveCurves` accepts only those the factory launched.
        return true;
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
            if (quoteAmount >= this.options.minTradeQuote) {
              const minutes = this.minuteVolume.get(usdgPool.ticker);
              const minute = Math.floor(atMs / MINUTE);
              minutes?.set(minute, (minutes.get(minute) ?? 0n) + quoteAmount);
            }
            if (atMs >= this.keepTradesFrom) {
              insertByTime(this.dexTrades.get(usdgPool.ticker), {
                eventId,
                poolId: event.poolId,
                blockNumber,
                at,
                quoteAmount,
                tokenAmount,
              });
            }
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
   * Looks up every contract seen trading as a curve, then records the trades
   * that were waiting on the answer.
   *
   * Only a curve the Pons V2 factory launched counts, and the factory's own
   * `TokenLaunched` is the proof: anything can emit a `CurveBuy`, and a
   * contract asked what it is can answer whatever it likes — including the
   * factory's address and a Stock Token — to buy Pons Power it never paid for.
   * A log from the factory's address cannot be forged.
   */
  private async resolveCurves(to: bigint): Promise<void> {
    if (this.pendingCurveTrades.length === 0) {
      return;
    }
    const unknown = [
      ...new Set(
        this.pendingCurveTrades
          .map(({ event }) => event.curve)
          .filter((curve) => !this.curves.has(curve) && !this.notCurves.has(curve)),
      ),
    ];
    for (let index = 0; index < unknown.length; index += CURVES_PER_QUERY) {
      const chunk = unknown.slice(index, index + CURVES_PER_QUERY);
      // A curve trades after it launches, so its launch is at or before `to`.
      this.apply(
        await this.scan(
          {
            address: this.options.addresses.ponsFactory,
            topics: [MARKET_TOPICS.tokenLaunched, null, chunk.map(pad)],
          },
          0n,
          to,
        ),
      );
    }
    for (const curve of unknown) {
      if (!this.curves.has(curve)) {
        this.notCurves.add(curve);
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
    const unknown = new Set<string>();
    for (const ticker of ACTIVE_TICKERS) {
      for (const trade of this.ponsTrades.get(ticker) ?? []) {
        if (trade.wallet === null && !this.senders.has(trade.transactionHash)) {
          unknown.add(trade.transactionHash);
        }
      }
    }
    if (unknown.size > 0) {
      const found = await this.options.rpc.transactionSenders([...unknown]);
      for (const hash of unknown) {
        const sender = found.get(hash);
        if (sender === undefined) {
          throw new Error(`market: no sender returned for transaction ${hash}`);
        }
        this.senders.set(hash, sender.toLowerCase());
      }
    }
    for (const ticker of ACTIVE_TICKERS) {
      const list = this.ponsTrades.get(ticker) ?? [];
      list.forEach((trade, index) => {
        const sender = this.senders.get(trade.transactionHash);
        if (trade.wallet === null && sender !== undefined) {
          list[index] = { ...trade, wallet: sender };
        }
      });
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

  /**
   * A block at or before `targetMs`, and no more than a block-search tolerance
   * before it.
   *
   * Interpolation on timestamps, aimed half a tolerance early so its first
   * guess usually lands inside it. Block times on Robinhood Chain are regular
   * enough that this takes a read or two, where bisection over sixty million
   * blocks took twenty-six — each a paced call to a throttled endpoint. A
   * probe that fails to halve the range is followed by a bisection step, which
   * bounds the worst case when blocks are not regular. Early is safe: the
   * indexer reads a few more blocks; late would miss trades it needs.
   */
  private async blockAtOrBefore(head: bigint, headAt: number, targetMs: number): Promise<bigint> {
    if (targetMs >= headAt) {
      return head;
    }
    let low = 0n;
    let lowAt = await this.clock.read(low);
    if (lowAt > targetMs) {
      return low;
    }
    let high = head;
    let highAt = headAt;
    const aimMs = targetMs - BLOCK_SEARCH_TOLERANCE_MS / 2;
    let bisect = false;
    while (high - low > 1n && targetMs - lowAt > BLOCK_SEARCH_TOLERANCE_MS) {
      const range = high - low;
      const middle = bisect
        ? (low + high) / 2n
        : clampBetween(
            low +
              (range * BigInt(Math.max(0, aimMs - lowAt))) / BigInt(Math.max(1, highAt - lowAt)),
            low,
            high,
          );
      const at = await this.clock.read(middle);
      if (at <= targetMs) {
        low = middle;
        lowAt = at;
      } else {
        high = middle;
        highAt = at;
      }
      bisect = !bisect && (high - low) * 2n > range;
    }
    return low;
  }

  private prune(): void {
    const now = this.covered;
    this.keepTradesFrom = now - this.options.tradeRetentionMs;
    const oldestMinute = Math.floor((now - this.options.volumeRetentionMs) / MINUTE);
    for (const ticker of ACTIVE_TICKERS) {
      const minutes = this.minuteVolume.get(ticker);
      for (const minute of minutes?.keys() ?? []) {
        if (minute < oldestMinute) {
          minutes?.delete(minute);
        }
      }
      dropBefore(this.dexTrades.get(ticker), now - this.options.tradeRetentionMs);
      dropBefore(this.ponsTrades.get(ticker), now - this.options.ponsRetentionMs);
    }
    this.clock.forgetBefore(
      now -
        Math.max(
          this.options.volumeRetentionMs,
          this.options.tradeRetentionMs,
          this.options.ponsRetentionMs,
        ),
    );
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

/** `value` moved strictly inside `(low, high)`, so every probe narrows the range. */
function clampBetween(value: bigint, low: bigint, high: bigint): bigint {
  return value <= low ? low + 1n : value >= high ? high - 1n : value;
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
