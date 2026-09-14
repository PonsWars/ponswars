import { NO_CARD_SUPPORT, type ConfidenceLookback } from '@ponswars/battle-math';
import { qualify, type NormalizedActivity, type QualificationPolicy } from '@ponswars/pons-indexer';
import type { MarketDataPort, MarketObservation, ObservationWindow } from '@ponswars/round-service';
import {
  CONFIDENCE_LOOKBACK,
  utcTimestamp,
  type ActiveTicker,
  type FeedHealth,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import {
  priceAt,
  type DexTrade,
  type PricePolicy,
  type PriceReading,
  type ReferencePrice,
  type TradeUnits,
} from './dex-price.js';
import {
  minuteBars,
  relativeVolume,
  volatilityOver,
  windowReturn,
  type Span,
} from './dex-window.js';
import { comparableSpans, isMarketOpen, type MarketCalendar } from './market-session.js';

/**
 * The market, read from Robinhood Chain (§12, §23).
 *
 * Every input a battle scores from comes from the chain the game runs on:
 *
 * - **Price momentum** — the Stock Token's DEX trades against a dollar token,
 *   priced by `priceAt` and guarded by Chainlink's on-chain feed (§23.7).
 * - **Relative volume** — the dollar value of those trades against the same
 *   stretch of earlier trading days (§12.2).
 * - **Pons activity** — trades of Pons launches quoted in the Stock Token,
 *   passed through the qualification engine (§12.3, §75).
 *
 * This class only computes. Where the trades come from is `MarketSource`, which
 * the chain package implements over an RPC endpoint and a test implements over
 * an array — so the arithmetic that decides battles is tested without a chain.
 */

/** What the chain has seen, as far as one ticker is concerned. */
export interface MarketSource {
  /** DEX trades of the ticker's token against the dollar token inside `[from, to)`. */
  trades(ticker: ActiveTicker, span: Span): readonly DexTrade[];
  /**
   * Pons trading quoted in the ticker's token inside `[from, to)`.
   *
   * `amount` in the dollar token's base units, so one dust threshold means the
   * same thing for a $20 stock and a $700 one.
   */
  ponsActivity(ticker: ActiveTicker, span: Span): readonly NormalizedActivity[];
  /** The latest independent reference price, or `null` if none was read. */
  reference(ticker: ActiveTicker): ReferencePrice | null;
  /** Decimals of the dollar token and of this ticker's token. */
  units(ticker: ActiveTicker): TradeUnits;
  /**
   * The latest instant the source has read everything up to.
   *
   * A source still backfilling does not know what traded, and silence from it
   * is not a quiet market. Before its first read this is zero.
   */
  coversUntil(): UtcTimestamp;
}

/** Everything `OPEN` about how the market is read (`docs/OPEN_PARAMETERS.md` §2). */
export interface OnchainMarketPolicy {
  readonly price: PricePolicy;
  /**
   * How far behind the instant the source may be and still be believed.
   *
   * A source always trails the head by a poll or two; one further behind than
   * this has stopped following the chain, and what it says about now is old.
   */
  readonly maxSourceLagMs: number;
  /** How far back the volatility baseline looks. */
  readonly volatilityLookbackMs: number;
  /** The smallest volatility a horizon may have, at `RATIO_SCALE`. */
  readonly volatilityFloor: bigint;
  /** How many earlier trading days relative volume is measured against. */
  readonly comparableSessions: number;
  /** The smallest expected notional, in the dollar token's base units. */
  readonly expectedNotionalFloor: bigint;
  /** How many equal parts the confidence lookback's path is cut into (§10.1). */
  readonly confidenceSubWindows: number;
  readonly pons: QualificationPolicy;
  readonly calendar: MarketCalendar;
}

const MINUTE = 60_000;

/** Health ordered from best to worst, so two can be combined by taking the worse. */
const SEVERITY: Readonly<Record<FeedHealth, number>> = {
  HEALTHY: 0,
  DEGRADED: 1,
  STALE: 2,
  UNAVAILABLE: 3,
};

function worst(...states: readonly FeedHealth[]): FeedHealth {
  return states.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'HEALTHY');
}

export class OnchainMarket implements MarketDataPort {
  constructor(
    private readonly source: MarketSource,
    private readonly policy: OnchainMarketPolicy,
  ) {}

  observe(ticker: ActiveTicker, { opensAt, at }: ObservationWindow): Promise<MarketObservation> {
    return Promise.resolve(this.observeNow(ticker, opensAt, at));
  }

  lookback(ticker: ActiveTicker, at: UtcTimestamp): Promise<ConfidenceLookback> {
    return Promise.resolve(this.lookbackNow(ticker, at));
  }

  private observeNow(
    ticker: ActiveTicker,
    opensAt: UtcTimestamp,
    at: UtcTimestamp,
  ): MarketObservation {
    const { price, calendar } = this.policy;
    const neutral = this.neutralInputs();

    const covered = this.source.coversUntil();
    if (covered <= 0) {
      // Not started: nothing has been read, so nothing can be said.
      return { inputs: neutral, health: 'UNAVAILABLE' };
    }
    if (at - covered > this.policy.maxSourceLagMs) {
      return { inputs: neutral, health: 'STALE' };
    }
    // §23.8: a closed market is not a flat one.
    if (!isMarketOpen(at, calendar)) {
      return { inputs: neutral, health: 'STALE' };
    }

    const earliest = utcTimestamp(Math.min(opensAt, at) - price.maxQuietMs);
    const trades = this.source.trades(ticker, { from: earliest, to: utcTimestamp(at + 1) });
    const units = this.source.units(ticker);
    const reference = this.source.reference(ticker);

    const opening = priceAt(trades, opensAt, units, reference, price);
    const closing = priceAt(trades, at, units, reference, price);
    const health = worst(opening.health, closing.health);
    if (opening.price === null || closing.price === null) {
      return { inputs: neutral, health: worst(health, 'STALE') };
    }

    const window: Span = { from: opensAt, to: at > opensAt ? at : utcTimestamp(opensAt + 1) };
    return {
      inputs: {
        windowReturn: windowReturn(opening.price, closing.price),
        volatility: this.volatility(ticker, at, at - opensAt),
        relativeVolume: this.relativeVolume(ticker, window),
        ...this.pons(ticker, window),
        // Card support is the battle's own, snapshotted at lock (§23.1). The
        // round loop replaces whatever a market puts here.
        cardSupport: NO_CARD_SUPPORT,
      },
      health,
    };
  }

  private lookbackNow(ticker: ActiveTicker, at: UtcTimestamp): ConfidenceLookback {
    const { price, confidenceSubWindows } = this.policy;
    const from = utcTimestamp(at - CONFIDENCE_LOOKBACK);
    const trades = this.source.trades(ticker, {
      from: utcTimestamp(from - price.maxQuietMs),
      to: utcTimestamp(at + 1),
    });
    const units = this.source.units(ticker);
    const reference = this.source.reference(ticker);
    const read = (instant: UtcTimestamp): PriceReading =>
      priceAt(trades, instant, units, reference, price);

    // Confidence is screening, not a score (§10.3): with no price at either end
    // the path is flat rather than invented.
    const parts = Math.max(1, confidenceSubWindows);
    const boundaries = Array.from({ length: parts + 1 }, (_, index) =>
      read(utcTimestamp(from + Math.round((CONFIDENCE_LOOKBACK * index) / parts))),
    );
    const subWindowReturns = boundaries.slice(1).map((reading, index) => {
      const previous = boundaries[index]?.price ?? null;
      return previous === null || reading.price === null
        ? 0n
        : windowReturn(previous, reading.price);
    });
    const first = boundaries[0]?.price ?? null;
    const last = boundaries[boundaries.length - 1]?.price ?? null;
    const span: Span = { from, to: at };

    return {
      windowReturn: first === null || last === null ? 0n : windowReturn(first, last),
      volatility: this.volatility(ticker, at, CONFIDENCE_LOOKBACK),
      relativeVolume: this.relativeVolume(ticker, span),
      qualifiedPonsActivity: this.pons(ticker, span).qualifiedPonsActivity,
      subWindowReturns,
    };
  }

  private volatility(ticker: ActiveTicker, at: UtcTimestamp, horizonMs: number): bigint {
    const { price, volatilityLookbackMs, volatilityFloor } = this.policy;
    const span: Span = { from: utcTimestamp(at - volatilityLookbackMs), to: at };
    const bars = minuteBars(
      this.source.trades(ticker, span),
      span,
      this.source.units(ticker),
      price.minTradeQuote,
    );
    return volatilityOver(bars, Math.max(MINUTE, horizonMs), volatilityFloor);
  }

  private relativeVolume(ticker: ActiveTicker, span: Span): bigint {
    const { price, comparableSessions, expectedNotionalFloor, calendar } = this.policy;
    const earlier = comparableSpans(span, comparableSessions, calendar);
    const oldest = earlier.reduce((min, entry) => (entry.from < min ? entry.from : min), span.from);
    const trades = this.source.trades(ticker, { from: oldest, to: span.to });
    return relativeVolume(trades, span, earlier, price.minTradeQuote, expectedNotionalFloor);
  }

  private pons(
    ticker: ActiveTicker,
    span: Span,
  ): { qualifiedPonsActivity: bigint; uniqueActiveWallets: bigint } {
    const result = qualify(ticker, this.source.ponsActivity(ticker, span), span, this.policy.pons);
    return {
      qualifiedPonsActivity: BigInt(result.qualifiedCount),
      uniqueActiveWallets: BigInt(result.uniqueActiveWallets),
    };
  }

  /** What a side scores from when there is nothing honest to score from. */
  private neutralInputs(): MarketObservation['inputs'] {
    return {
      windowReturn: 0n,
      volatility: this.policy.volatilityFloor,
      relativeVolume: 0n,
      qualifiedPonsActivity: 0n,
      uniqueActiveWallets: 0n,
      cardSupport: NO_CARD_SUPPORT,
    };
  }
}
