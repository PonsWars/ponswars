import { DeterministicPrng, RATIO_SCALE, type SideInputs } from '@ponswars/battle-math';
import { NO_CARD_SUPPORT } from '@ponswars/battle-math';
import type { ActiveTicker, FeedHealth } from '@ponswars/shared-types';

/**
 * A synthetic market, deterministic from a seed.
 *
 * Not a model of any real market and not trying to be. Its job is to produce
 * plausible, varied, **reproducible** inputs so a simulation exercises the
 * engine across contested battles, blowouts, comebacks and feed failures — and
 * so a failing run can be replayed exactly from its seed.
 *
 * §54 asks for deterministic simulations before production. Anything driven by
 * `Math.random()` would produce a failure nobody could reproduce, which is the
 * opposite of useful.
 */

const MARKET_DOMAIN = 'PONSWARS_SIMULATED_MARKET_V1';

export interface MarketConfig {
  /** Chance in ten thousand that a tick reports unusable data. */
  readonly feedFailureBps: number;
  /** Chance in ten thousand that a tick reports degraded but usable data. */
  readonly feedDegradedBps: number;
  /** Largest absolute volatility-adjusted return a ticker can post. */
  readonly maxReturnScaled: bigint;
}

export const DEFAULT_MARKET: MarketConfig = {
  feedFailureBps: 0,
  feedDegradedBps: 500,
  maxReturnScaled: 3n * RATIO_SCALE,
};

export interface TickerObservation {
  readonly inputs: SideInputs;
  readonly health: FeedHealth;
}

/**
 * Produces one ticker's observation for a given round and tick.
 *
 * The stream is keyed by round, tick and ticker, so the same simulation always
 * sees the same market and two tickers never share a stream.
 */
export function observe(
  seedHex: string,
  roundIndex: number,
  tickIndex: number,
  ticker: ActiveTicker,
  config: MarketConfig = DEFAULT_MARKET,
): TickerObservation {
  const prng = new DeterministicPrng(
    seedHex,
    `${MARKET_DOMAIN}|${String(roundIndex)}|${String(tickIndex)}|${ticker}`,
  );

  const failureRoll = prng.nextBelow(10_000);
  const health: FeedHealth =
    failureRoll < config.feedFailureBps
      ? 'STALE'
      : failureRoll < config.feedFailureBps + config.feedDegradedBps
        ? 'DEGRADED'
        : 'HEALTHY';

  // A signed return in [-max, +max], drawn uniformly over a fine grid so the
  // engine sees contested battles as often as lopsided ones.
  const span = Number(config.maxReturnScaled / 1_000n) * 2 + 1;
  const windowReturn = BigInt(prng.nextBelow(span) - (span - 1) / 2) * 1_000n;

  // Relative volume clusters around 1.0 — most windows look ordinary, some do
  // not. §12.2 compares against an expected baseline, so 1.0 means "as
  // expected" rather than "no volume".
  const relativeVolume = 500_000n + BigInt(prng.nextBelow(2_000_000));

  return {
    inputs: {
      windowReturn,
      volatility: RATIO_SCALE,
      relativeVolume,
      qualifiedPonsActivity: BigInt(prng.nextBelow(5_000)),
      uniqueActiveWallets: BigInt(prng.nextBelow(500)),
      cardSupport: NO_CARD_SUPPORT,
    },
    health,
  };
}
