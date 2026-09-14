import type { FeedHealth, UtcTimestamp } from '@ponswars/shared-types';

/**
 * A stock token's price, read from its trades on Robinhood Chain (§23.2, §23.7).
 *
 * The price source is the market itself: swaps of the Stock Token against a
 * dollar token on the chain's DEX pools. That is free, on chain and
 * reproducible from logs — and it is also a market anyone can trade into. A
 * thinly traded pool can be pushed by a small trade, so every reading here is
 * guarded three ways before it is allowed to decide a battle:
 *
 * 1. **Dust is ignored.** A trade below the minimum notional moves nothing.
 * 2. **The price is a notional-weighted median**, not a mean. Moving it takes
 *    more than half the traded value in the window, not one outlier.
 * 3. **It is checked against an independent reference** (§23.7) — Chainlink's
 *    on-chain feed for the same Stock Token. Trades far from the reference are
 *    dropped as outliers, and a median that still disagrees with it beyond the
 *    integrity bound is not a price: the feed is `STALE`, and a battle on it
 *    voids rather than being decided by it (§4.4).
 *
 * Pure: no clock, no chain. The same trades, reference and policy always give
 * the same reading, so a battle's evidence can be replayed from its logs.
 *
 * Integer throughout (ADR 0003). A price is USD at {@link PRICE_SCALE}.
 */

/** A price in USD, scaled: `100_000_000n` is $1.00 — the scale Chainlink's USD feeds use. */
export const PRICE_SCALE = 100_000_000n;

/** Basis points in a whole. */
const BPS = 10_000n;

/** One swap of a Stock Token against a dollar token, already decoded. */
export interface DexTrade {
  /** Deterministic identity: transaction hash and log index. */
  readonly eventId: string;
  /** Which pool it traded in, for diagnostics and pool-level exclusion. */
  readonly poolId: string;
  readonly blockNumber: number;
  /** Block time. */
  readonly at: UtcTimestamp;
  /** Dollar side, absolute, in the dollar token's base units. */
  readonly quoteAmount: bigint;
  /** Stock Token side, absolute, in the token's base units. */
  readonly tokenAmount: bigint;
}

/** Decimals of the two sides, so a trade's amounts become a price. */
export interface TradeUnits {
  readonly quoteDecimals: number;
  readonly tokenDecimals: number;
}

/** The independent reference price (§23.7). */
export interface ReferencePrice {
  /** USD at {@link PRICE_SCALE}. */
  readonly price: bigint;
  /** When the reference last updated. */
  readonly updatedAt: UtcTimestamp;
}

/**
 * How a price is read and when it is trusted.
 *
 * Every field is `OPEN` (`docs/OPEN_PARAMETERS.md` §2): they decide when a
 * battle voids, which is a product decision. So they arrive from configuration
 * and none of them has a default here.
 */
export interface PricePolicy {
  /** How far back from the instant trades are pooled into one price. */
  readonly priceWindowMs: number;
  /**
   * How long without a trade the last price may still stand in.
   *
   * A price older than this is not a price any more: the feed is `STALE`.
   */
  readonly maxQuietMs: number;
  /** Smallest trade that counts, in the dollar token's base units. */
  readonly minTradeQuote: bigint;
  /** A trade further than this from the reference is an outlier and is dropped. */
  readonly maxTradeDeviationBps: bigint;
  /** A median further than this from the reference is an integrity failure. */
  readonly maxPriceDeviationBps: bigint;
  /** A reference older than this cannot vouch for anything. */
  readonly maxReferenceAgeMs: number;
  /** Fewer counted trades than this in the window reads as `DEGRADED`. */
  readonly minWindowTrades: number;
}

/** Why a reading has the health it has, for logs and evidence (§75.5). */
export type PriceNote =
  'OK' | 'THIN' | 'CARRIED' | 'NO_REFERENCE' | 'NO_TRADES' | 'REFERENCE_DIVERGENCE';

export interface PriceReading {
  /** USD at {@link PRICE_SCALE}; `null` when there is none to give. */
  readonly price: bigint | null;
  readonly health: FeedHealth;
  readonly note: PriceNote;
  /** Trades that counted towards the price. */
  readonly trades: number;
  /** Their total dollar notional, in the dollar token's base units. */
  readonly notional: bigint;
  /** The newest counted trade, or `null` when none counted. */
  readonly lastTradeAt: UtcTimestamp | null;
}

/**
 * A trade's price in USD at {@link PRICE_SCALE}.
 *
 * @throws RangeError on a trade with no token side, which has no price.
 */
export function tradePrice(trade: DexTrade, units: TradeUnits): bigint {
  if (trade.tokenAmount <= 0n || trade.quoteAmount < 0n) {
    throw new RangeError(`Trade ${trade.eventId} has no token amount to price against`);
  }
  // quote / 10^qd  ÷  token / 10^td, at PRICE_SCALE.
  return (
    (trade.quoteAmount * PRICE_SCALE * 10n ** BigInt(units.tokenDecimals)) /
    (trade.tokenAmount * 10n ** BigInt(units.quoteDecimals))
  );
}

/** |a − b| as basis points of `b`. */
export function deviationBps(a: bigint, b: bigint): bigint {
  if (b <= 0n) {
    throw new RangeError('A deviation is measured against a positive price');
  }
  const difference = a > b ? a - b : b - a;
  return (difference * BPS) / b;
}

/**
 * The notional-weighted median price of a set of trades.
 *
 * The price at which half the traded value was at or below. Ties in price are
 * broken by event id, so the answer does not depend on the order the logs
 * arrived in.
 */
export function weightedMedianPrice(
  priced: readonly { readonly price: bigint; readonly weight: bigint; readonly id: string }[],
): bigint | null {
  if (priced.length === 0) {
    return null;
  }
  const ordered = [...priced].sort((a, b) =>
    a.price !== b.price ? (a.price < b.price ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const total = ordered.reduce((sum, entry) => sum + entry.weight, 0n);
  if (total <= 0n) {
    return null;
  }
  let running = 0n;
  for (const entry of ordered) {
    running += entry.weight;
    // At or past half: `2 × running ≥ total` keeps this in integers.
    if (running * 2n >= total) {
      return entry.price;
    }
  }
  return ordered[ordered.length - 1]?.price ?? null;
}

/**
 * The price of a Stock Token at an instant.
 *
 * `trades` should cover at least `(at − maxQuietMs, at]`; anything outside is
 * ignored, so passing more is harmless.
 */
export function priceAt(
  trades: readonly DexTrade[],
  at: UtcTimestamp,
  units: TradeUnits,
  reference: ReferencePrice | null,
  policy: PricePolicy,
): PriceReading {
  const trustedReference =
    reference !== null &&
    reference.price > 0n &&
    at - reference.updatedAt <= policy.maxReferenceAgeMs
      ? reference
      : null;

  const counted = trades
    .filter((trade) => trade.at <= at && at - trade.at < policy.maxQuietMs)
    .filter((trade) => trade.tokenAmount > 0n && trade.quoteAmount >= policy.minTradeQuote)
    .map((trade) => ({ trade, price: tradePrice(trade, units) }))
    .filter(
      ({ price }) =>
        trustedReference === null ||
        deviationBps(price, trustedReference.price) <= policy.maxTradeDeviationBps,
    );

  const inWindow = counted.filter(({ trade }) => at - trade.at < policy.priceWindowMs);
  // Only the latest trades carry a price once the window is empty: the last
  // price stands in until it is older than `maxQuietMs`, and no longer.
  const carried = inWindow.length === 0 && counted.length > 0;
  const basis = carried ? latestTrades(counted) : inWindow;

  const price = weightedMedianPrice(
    basis.map(({ trade, price: tradeValue }) => ({
      price: tradeValue,
      weight: trade.quoteAmount,
      id: trade.eventId,
    })),
  );
  const notional = inWindow.reduce((sum, { trade }) => sum + trade.quoteAmount, 0n);
  const lastTradeAt = counted.reduce<UtcTimestamp | null>(
    (latest, { trade }) => (latest === null || trade.at > latest ? trade.at : latest),
    null,
  );
  const base = { trades: inWindow.length, notional, lastTradeAt };

  if (price === null) {
    return { ...base, price: null, health: 'STALE', note: 'NO_TRADES' };
  }
  if (
    trustedReference !== null &&
    deviationBps(price, trustedReference.price) > policy.maxPriceDeviationBps
  ) {
    return { ...base, price, health: 'STALE', note: 'REFERENCE_DIVERGENCE' };
  }
  if (carried) {
    return { ...base, price, health: 'DEGRADED', note: 'CARRIED' };
  }
  if (trustedReference === null) {
    // Real trades, but nothing independent vouches for them (§23.7).
    return { ...base, price, health: 'DEGRADED', note: 'NO_REFERENCE' };
  }
  if (inWindow.length < policy.minWindowTrades) {
    return { ...base, price, health: 'DEGRADED', note: 'THIN' };
  }
  return { ...base, price, health: 'HEALTHY', note: 'OK' };
}

/** The trades in the newest block that has any, which is what a carried price is made of. */
function latestTrades<T extends { readonly trade: DexTrade }>(entries: readonly T[]): readonly T[] {
  const newest = entries.reduce((max, { trade }) => (trade.at > max ? trade.at : max), -Infinity);
  return entries.filter(({ trade }) => trade.at === newest);
}
