import { CURRENT_ENGINE_VERSIONS, type EngineConfig } from '@ponswars/battle-engine';
import { RATIO_SCALE } from '@ponswars/battle-math';
import {
  ACTIVE_TICKERS,
  milliseconds,
  tokenDecimals,
  type ConfidenceLabel,
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

/** A spread of confidence labels, so the upset paths are exercised too. */
const LABEL_CYCLE: readonly ConfidenceLabel[] = [
  'EVEN',
  'FAVORED',
  'UNDERDOG',
  'STRONG_FAVORITE',
  'HEAVY_UNDERDOG',
];

export const CONFIDENCE_LABELS_BY_TICKER: Readonly<Record<string, ConfidenceLabel>> =
  Object.fromEntries(
    ACTIVE_TICKERS.map((ticker, index) => [
      ticker,
      LABEL_CYCLE[index % LABEL_CYCLE.length] ?? 'EVEN',
    ]),
  );

export const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

export const WALLET_COUNT = 120;

/** Nine scoring ticks, one a minute across the battle window (§3.1). */
export const TICKS_PER_BATTLE = 9;
