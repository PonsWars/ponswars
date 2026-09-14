import { RATIO_SCALE } from '@ponswars/battle-math';
import { integerSqrt, type UtcTimestamp } from '@ponswars/shared-types';
import { tradePrice, weightedMedianPrice, type DexTrade, type TradeUnits } from './dex-price.js';

/**
 * What a battle window did, from the trades inside it (§12.1, §12.2, §10.1).
 *
 * The price at one instant is `priceAt`'s. These are the quantities built from
 * many of them: the return since lock, the asset's own volatility, and volume
 * against what is normal for the same stretch of a trading day.
 *
 * All at `RATIO_SCALE`, the scale the battle score reads: `1_000_000n` is a
 * return of 100% and a relative volume of exactly 1×. Pure and integer.
 */

/** A half-open stretch of time, `[from, to)`. */
export interface Span {
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
}

const MINUTE = 60_000;

/**
 * The return from one price to another, at `RATIO_SCALE`.
 *
 * @throws RangeError on a non-positive starting price.
 */
export function windowReturn(opening: bigint, closing: bigint): bigint {
  if (opening <= 0n) {
    throw new RangeError('A return is measured from a positive price');
  }
  return ((closing - opening) * RATIO_SCALE) / opening;
}

/** Trades inside a span that are large enough to count. */
function countedIn(trades: readonly DexTrade[], span: Span, minTradeQuote: bigint): DexTrade[] {
  return trades.filter(
    (trade) =>
      trade.at >= span.from &&
      trade.at < span.to &&
      trade.tokenAmount > 0n &&
      trade.quoteAmount >= minTradeQuote,
  );
}

/** The dollar value that traded in a span, in the dollar token's base units. */
export function notionalIn(trades: readonly DexTrade[], span: Span, minTradeQuote: bigint): bigint {
  return countedIn(trades, span, minTradeQuote).reduce((sum, trade) => sum + trade.quoteAmount, 0n);
}

/**
 * The notional-weighted median price of each whole minute in a span that
 * traded, oldest first. Minutes with no counted trade are absent.
 */
export function minuteBars(
  trades: readonly DexTrade[],
  span: Span,
  units: TradeUnits,
  minTradeQuote: bigint,
): { readonly minute: number; readonly price: bigint }[] {
  const buckets = new Map<number, DexTrade[]>();
  for (const trade of countedIn(trades, span, minTradeQuote)) {
    const minute = Math.floor(trade.at / MINUTE);
    const bucket = buckets.get(minute);
    if (bucket === undefined) {
      buckets.set(minute, [trade]);
    } else {
      bucket.push(trade);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([minute, bucket]) => {
      const price = weightedMedianPrice(
        bucket.map((trade) => ({
          price: tradePrice(trade, units),
          weight: trade.quoteAmount,
          id: trade.eventId,
        })),
      );
      return price === null ? [] : [{ minute, price }];
    });
}

/**
 * An asset's volatility over a horizon, at `RATIO_SCALE` (§12.1).
 *
 * The per-minute variance is measured from the minute bars of a trailing span
 * — a gap between two traded minutes contributes its return once, over the
 * minutes it spans, so a quiet stretch neither inflates nor hides the variance
 * — and scaled to the horizon by the square root of its length in minutes. So
 * a return over nine minutes is compared with what nine minutes usually move.
 *
 * Never below `floor`: a market that happened to sit still for an hour must not
 * make an ordinary move read as a many-sigma event.
 */
export function volatilityOver(
  bars: readonly { readonly minute: number; readonly price: bigint }[],
  horizonMs: number,
  floor: bigint,
): bigint {
  if (floor <= 0n) {
    throw new RangeError('The volatility floor must be positive');
  }
  let squares = 0n;
  let minutes = 0n;
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const step = windowReturn(previous.price, current.price);
    squares += step * step;
    minutes += BigInt(current.minute - previous.minute);
  }
  if (minutes === 0n) {
    return floor;
  }
  const perMinute = integerSqrt(squares / minutes);
  const horizonMinutes = BigInt(Math.max(1, Math.round(horizonMs / MINUTE)));
  // sqrt(horizon) at RATIO_SCALE, then back down.
  const scaled =
    (perMinute * integerSqrt(horizonMinutes * RATIO_SCALE * RATIO_SCALE)) / RATIO_SCALE;
  return scaled > floor ? scaled : floor;
}

/**
 * Notional against what is normal for the same stretch of a trading day (§12.2).
 *
 * `comparable` are the dollar totals of the same span on earlier trading
 * sessions — the calendar decides which days those are. The expectation is
 * their mean, and never below `floor`, so a ticker that barely traded last week
 * does not turn one ordinary trade today into a many-times surge.
 */
export function relativeVolume(
  actual: bigint,
  comparable: readonly bigint[],
  floor: bigint,
): bigint {
  if (floor <= 0n) {
    throw new RangeError('The expected-volume floor must be positive');
  }
  const expected =
    comparable.length === 0
      ? 0n
      : comparable.reduce((sum, total) => sum + total, 0n) / BigInt(comparable.length);
  const baseline = expected > floor ? expected : floor;
  return (actual * RATIO_SCALE) / baseline;
}
