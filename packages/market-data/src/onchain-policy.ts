import { parseDecimalToBaseUnits, tokenDecimals, type TokenDecimals } from '@ponswars/shared-types';
import { parseHolidays } from './market-session.js';
import type { OnchainMarketPolicy } from './onchain-market.js';

/**
 * The on-chain market's bounds, from the parameters that set them.
 *
 * One mapping, used by the server that decides battles and by the calibration
 * that measures them. If the two read the same `MARKET_*` values differently,
 * calibration would be measuring a market no battle is scored against.
 *
 * The settings are named as the environment names them, so the server passes
 * its validated `Config` and a calibration candidate is a list of the same
 * variables an operator would set.
 */

export interface OnchainMarketSettings {
  readonly PRICE_FEED_STALE_AFTER_MS: number;
  readonly VOLUME_FEED_STALE_AFTER_MS: number;
  readonly PONS_FEED_STALE_AFTER_MS: number;
  readonly MARKET_PRICE_WINDOW_MS: number;
  readonly MARKET_MIN_TRADE_USD: string;
  readonly MARKET_OUTLIER_BPS: number;
  readonly MARKET_DIVERGENCE_BPS: number;
  readonly MARKET_REFERENCE_MAX_AGE_MS: number;
  readonly MARKET_MIN_WINDOW_TRADES: number;
  readonly MARKET_VOLATILITY_LOOKBACK_MS: number;
  readonly MARKET_VOLATILITY_FLOOR_BPS: number;
  readonly MARKET_COMPARABLE_SESSIONS: number;
  readonly MARKET_EXPECTED_VOLUME_FLOOR_USD: string;
  readonly MARKET_HOLIDAYS: readonly string[];
  readonly PONS_MIN_ACTIVITY_USD: string;
  readonly PONS_MAX_IDENTICAL_PER_WALLET: number;
}

/** What the chain itself says, and the settings cannot. */
export interface OnchainMarketFacts {
  /** Decimals of the dollar token trades are quoted in. */
  readonly quoteDecimals: number;
  /** Addresses whose Pons trading is never a player's: routers and the like. */
  readonly excludedAddresses: readonly string[];
}

/** How far behind the chain the indexer may be before its market is STALE. */
export const MAX_SOURCE_LAG_MS = 30_000;

/**
 * How many equal parts the confidence lookback's path is cut into (§10.1).
 *
 * Sixty fifteen-second parts: the shape the momentum-stability bands in
 * `CONFIDENCE_CALIBRATION` were measured against. A different count counts
 * direction changes on a different scale.
 */
export const CONFIDENCE_SUB_WINDOWS = 60;

/** The Pons qualification rules' version, stamped on every result (§75.5). */
export const PONS_POLICY_VERSION = 'pons-onchain-v1';

export function onchainMarketPolicy(
  settings: OnchainMarketSettings,
  facts: OnchainMarketFacts,
): OnchainMarketPolicy {
  const decimals: TokenDecimals = tokenDecimals(facts.quoteDecimals);
  // Dollar amounts are set in USD and compared in the quote token's base units.
  const usd = (decimal: string): bigint => parseDecimalToBaseUnits(decimal, decimals);
  const minTradeQuote = usd(settings.MARKET_MIN_TRADE_USD);
  return {
    price: {
      priceWindowMs: settings.MARKET_PRICE_WINDOW_MS,
      maxQuietMs: settings.PRICE_FEED_STALE_AFTER_MS,
      minTradeQuote,
      maxTradeDeviationBps: BigInt(settings.MARKET_OUTLIER_BPS),
      maxPriceDeviationBps: BigInt(settings.MARKET_DIVERGENCE_BPS),
      maxReferenceAgeMs: settings.MARKET_REFERENCE_MAX_AGE_MS,
      minWindowTrades: settings.MARKET_MIN_WINDOW_TRADES,
    },
    maxSourceLagMs: Math.min(
      MAX_SOURCE_LAG_MS,
      settings.VOLUME_FEED_STALE_AFTER_MS,
      settings.PONS_FEED_STALE_AFTER_MS,
    ),
    volatilityLookbackMs: settings.MARKET_VOLATILITY_LOOKBACK_MS,
    // Basis points to RATIO_SCALE, where 1_000_000 is 100%.
    volatilityFloor: BigInt(settings.MARKET_VOLATILITY_FLOOR_BPS) * 100n,
    comparableSessions: settings.MARKET_COMPARABLE_SESSIONS,
    expectedNotionalFloor: usd(settings.MARKET_EXPECTED_VOLUME_FLOOR_USD),
    confidenceSubWindows: CONFIDENCE_SUB_WINDOWS,
    pons: {
      minimumAmount: usd(settings.PONS_MIN_ACTIVITY_USD),
      maxIdenticalPerWallet: settings.PONS_MAX_IDENTICAL_PER_WALLET,
      excludedAddresses: new Set(facts.excludedAddresses.map((address) => address.toLowerCase())),
      version: PONS_POLICY_VERSION,
    },
    calendar: { holidays: parseHolidays(settings.MARKET_HOLIDAYS.join(',')) },
  };
}
