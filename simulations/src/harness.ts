import { CURRENT_ENGINE_VERSIONS, type EngineConfig } from '@ponswars/battle-engine';
import {
  RATIO_SCALE,
  type ConfidenceCalibration,
  type ConfidenceLookback,
} from '@ponswars/battle-math';
import {
  ACTIVE_TICKERS,
  milliseconds,
  tokenDecimals,
  type TokenDecimals,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';

/**
 * Shared fixtures for the simulations.
 *
 * One definition of the engine configuration, the epoch and the seeds, so a
 * replay and the full-cycle run are demonstrably exercising the same engine. Two
 * copies of a tuning table would let a replay quietly "reproduce" a result the
 * production configuration never would have produced.
 */

export const EPOCH: UtcTimestamp = 1_800_000_000_000 as UtcTimestamp;

/** Base entropy for matchmaking and picks. Every simulation is seeded (§54). */
export const SEED = `0x${'5c'.repeat(32)}`;

/** Stand-in for the finalization block hash (§13.6). */
export const BLOCK = `0x${'e1'.repeat(32)}`;

export const SPY: TokenDecimals = tokenDecimals(6);

export const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 20n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

/**
 * Where each confidence band begins for the simulations (§10.1, §102).
 *
 * `OPEN`, like every other calibration here: these are the simulation's values,
 * chosen so that all six labels in §10.2 are reachable across five matchups.
 */
export const CONFIDENCE_CALIBRATION: ConfidenceCalibration = {
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: (RATIO_SCALE * 13n) / 10n, weak: (RATIO_SCALE * 7n) / 10n },
  ponsActivity: { high: 40n, medium: 15n },
  momentumStability: { stable: 2, mixed: 5 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

/** Return, volume, activity and path for each band rank, weakest first. */
const TREND = [-RATIO_SCALE, 0n, RATIO_SCALE] as const;
const VOLUME = [RATIO_SCALE / 2n, RATIO_SCALE, RATIO_SCALE * 2n] as const;
const PONS = [1n, 20n, 100n] as const;
const PATH = [
  [10n, -10n, 10n, -10n, 10n, -10n, 10n],
  [10n, -10n, 10n, -10n],
  [10n, 20n, 30n],
] as const;

/** A lookback whose four bands sit at the given ranks (§10.1 order). */
function lookbackAt(
  price: number,
  volume: number,
  pons: number,
  stability: number,
): ConfidenceLookback {
  return {
    windowReturn: TREND[price] ?? 0n,
    volatility: RATIO_SCALE,
    relativeVolume: VOLUME[volume] ?? RATIO_SCALE,
    qualifiedPonsActivity: PONS[pons] ?? 20n,
    subWindowReturns: PATH[stability] ?? [],
  };
}

/**
 * Five strengths, so the matchups between them cover the label vocabulary.
 *
 * Strengths rather than labels, because §10.2 makes a label relative: a
 * simulation cannot assign `HEAVY_UNDERDOG` to a ticker, only give it a bad
 * fifteen minutes and let the pairing decide what that makes it. Standings of
 * 0, 60, 100, 140 and 200 against the gaps above reach every label including
 * both upset tiers, which is what the upset award paths need.
 */
const NEUTRAL_LOOKBACK = lookbackAt(1, 1, 1, 1);

const STRENGTH_CYCLE: readonly ConfidenceLookback[] = [
  NEUTRAL_LOOKBACK,
  lookbackAt(2, 1, 1, 1),
  lookbackAt(0, 1, 1, 1),
  lookbackAt(2, 2, 2, 2),
  lookbackAt(0, 0, 0, 0),
];

export const CONFIDENCE_BY_TICKER = {
  lookback: Object.fromEntries(
    ACTIVE_TICKERS.map((ticker, index) => [
      ticker,
      STRENGTH_CYCLE[index % STRENGTH_CYCLE.length] ?? NEUTRAL_LOOKBACK,
    ]),
  ),
  calibration: CONFIDENCE_CALIBRATION,
};

export const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

export const WALLET_COUNT = 120;

/** Nine scoring ticks, one a minute across the battle window (§3.1). */
export const TICKS_PER_BATTLE = 9;
