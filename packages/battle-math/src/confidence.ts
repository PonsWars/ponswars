import {
  CONFIDENCE_INPUT_WEIGHTS,
  type ConfidenceLabel,
  type ConfidenceSnapshot,
  type MomentumStabilitySignal,
  type PonsActivitySignal,
  type PriceTrendSignal,
  type VolumePulseSignal,
} from '@ponswars/shared-types';
import { divScaled } from './scale.js';

/**
 * Battle Confidence (§10).
 *
 * Pre-battle screening intelligence, snapshotted when the round opens and
 * finished with at lock. It is **not** a probability: §10 forbids showing an
 * exact percentage, and nothing here produces one — the only numbers in this
 * file are ordinals used to rank two sides against each other, and none of them
 * reaches the snapshot a client renders.
 *
 * Two properties are worth stating because they hold by shape rather than by
 * care.
 *
 * The label is computed from exactly the four sub-signals the player is shown.
 * A separate numeric pipeline behind the label would let a panel read
 * `STRONG / RISING / HIGH / STABLE` beside the word `UNDERDOG`, and a player
 * seeing that would be right to distrust both. Here it cannot happen: the label
 * is a comparison of two weighted sums of those same four bands.
 *
 * And §10.3 keeps confidence out of the battle score. `ConfidenceLookback` has
 * no card-support field, so the one input §10.3 names explicitly cannot be
 * passed in at all; this file does not import the scoring module, and the
 * scoring module does not import this one.
 */

/**
 * What is known about one ticker over the fifteen minutes before Pick Phase
 * (§10.1).
 *
 * Deliberately not `SideInputs`. That type carries card support and describes
 * the nine-minute battle window; this one describes a different window for a
 * different purpose, and sharing a type would be the first step toward sharing
 * a number.
 */
export interface ConfidenceLookback {
  /** Return over the lookback window, scaled. `10_000n` is +1%. */
  readonly windowReturn: bigint;
  /**
   * The ticker's own volatility over the window, scaled and strictly positive.
   *
   * Price trend is judged after dividing by it, for the same reason §12.1
   * does: without it a naturally jumpy stock would read as `STRONG` on an
   * ordinary day, and confidence would be describing the asset rather than the
   * moment.
   */
  readonly volatility: bigint;
  /** Volume relative to the ticker's own baseline, scaled. */
  readonly relativeVolume: bigint;
  /** Qualified Pons activity over the window (§10.1, §12.3). */
  readonly qualifiedPonsActivity: bigint;
  /**
   * Returns of the equal sub-intervals of the window, oldest first.
   *
   * Momentum stability is history-dependent — a window that ended where it
   * started could have drifted there or thrashed there, and §10.1 counts those
   * differently. The closing return cannot tell them apart, so the path comes
   * in with it.
   */
  readonly subWindowReturns: readonly bigint[];
}

/**
 * Where each qualitative band begins.
 *
 * `CALIBRATE`: §10 locks the inputs, their weights and the vocabulary, and
 * names no numbers at all. These are therefore an **input** rather than a
 * compiled default, so no engineer can ship a calibration as product policy
 * (§102).
 */
export interface ConfidenceCalibration {
  /** Volatility-adjusted return bands for price trend. */
  readonly priceTrend: { readonly strong: bigint; readonly weak: bigint };
  /** Relative-volume bands for volume pulse. */
  readonly volumePulse: { readonly rising: bigint; readonly weak: bigint };
  /** Qualified-activity bands for Pons activity. */
  readonly ponsActivity: { readonly high: bigint; readonly medium: bigint };
  /** Largest direction-change count still counted as each band. */
  readonly momentumStability: { readonly stable: number; readonly mixed: number };
  /**
   * Standing gaps that separate the relative labels (§10.2).
   *
   * A standing runs 0–200, so a gap runs −200–200. Below `favored` in either
   * direction the matchup is `EVEN`.
   */
  readonly matchup: {
    readonly favored: number;
    readonly strongFavorite: number;
    readonly dominant: number;
  };
}

/**
 * How strongly each band argues for a side.
 *
 * Three bands, so 0–2. The weights in §10.1 are percentages of a whole, which
 * makes the weighted sum 0–200 and the arithmetic exact in a `number` — this is
 * an ordinal ranking, not a value-bearing quantity, so §66.4's `bigint` rule
 * does not reach it.
 */
const PRICE_TREND_RANK: Readonly<Record<PriceTrendSignal, number>> = {
  STRONG: 2,
  MIXED: 1,
  WEAK: 0,
};
const VOLUME_PULSE_RANK: Readonly<Record<VolumePulseSignal, number>> = {
  RISING: 2,
  NORMAL: 1,
  WEAK: 0,
};
const PONS_ACTIVITY_RANK: Readonly<Record<PonsActivitySignal, number>> = {
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
};
const MOMENTUM_STABILITY_RANK: Readonly<Record<MomentumStabilitySignal, number>> = {
  STABLE: 2,
  MIXED: 1,
  UNSTABLE: 0,
};

/** The highest standing any side can reach: every band at its top rank. */
export const MAX_CONFIDENCE_STANDING =
  2 *
  (CONFIDENCE_INPUT_WEIGHTS.recentPriceTrend +
    CONFIDENCE_INPUT_WEIGHTS.relativeVolumePulse +
    CONFIDENCE_INPUT_WEIGHTS.ponsActivity +
    CONFIDENCE_INPUT_WEIGHTS.recentMomentumStability);

/**
 * How many times the return changed direction across the window.
 *
 * A flat sub-interval is not a direction change and does not clear the running
 * direction either: a quiet minute in the middle of a climb is part of the
 * climb, and counting it as a reversal would make a calm market read as an
 * unstable one.
 */
export function directionChanges(subWindowReturns: readonly bigint[]): number {
  let changes = 0;
  let previous = 0;
  for (const value of subWindowReturns) {
    const direction = value > 0n ? 1 : value < 0n ? -1 : 0;
    if (direction !== 0) {
      if (previous !== 0 && direction !== previous) {
        changes += 1;
      }
      previous = direction;
    }
  }
  return changes;
}

/** The four qualitative sub-signals for one side (§10.2). */
export function subSignals(
  lookback: ConfidenceLookback,
  calibration: ConfidenceCalibration,
): Omit<ConfidenceSnapshot, 'label'> {
  if (lookback.volatility <= 0n) {
    throw new RangeError('Confidence lookback needs a strictly positive volatility');
  }

  const adjustedReturn = divScaled(lookback.windowReturn, lookback.volatility);
  const changes = directionChanges(lookback.subWindowReturns);

  return {
    priceTrend: bandOf(adjustedReturn, calibration.priceTrend.strong, calibration.priceTrend.weak, [
      'STRONG',
      'MIXED',
      'WEAK',
    ]),
    volumePulse: bandOf(
      lookback.relativeVolume,
      calibration.volumePulse.rising,
      calibration.volumePulse.weak,
      ['RISING', 'NORMAL', 'WEAK'],
    ),
    ponsActivity:
      lookback.qualifiedPonsActivity >= calibration.ponsActivity.high
        ? 'HIGH'
        : lookback.qualifiedPonsActivity >= calibration.ponsActivity.medium
          ? 'MEDIUM'
          : 'LOW',
    momentumStability:
      changes <= calibration.momentumStability.stable
        ? 'STABLE'
        : changes <= calibration.momentumStability.mixed
          ? 'MIXED'
          : 'UNSTABLE',
  };
}

/**
 * Places a value in a three-band scale with an open top and an open bottom.
 *
 * Price trend and volume pulse share it because they share a shape: a high
 * band, a low band, and everything else in the middle. Pons activity and
 * stability do not — their bands are both measured from the same end — so they
 * are written out rather than bent into this.
 */
function bandOf<T extends string>(
  value: bigint,
  high: bigint,
  low: bigint,
  [above, between, below]: readonly [T, T, T],
): T {
  if (value >= high) return above;
  if (value <= low) return below;
  return between;
}

/**
 * One side's standing, 0–200, weighted by §10.1.
 *
 * Not exported, and not carried on a snapshot. §10 forbids an exact
 * probability, and a number a client could render beside two stocks is one
 * subtraction away from being read as one.
 */
function standing(signals: Omit<ConfidenceSnapshot, 'label'>): number {
  return (
    CONFIDENCE_INPUT_WEIGHTS.recentPriceTrend * PRICE_TREND_RANK[signals.priceTrend] +
    CONFIDENCE_INPUT_WEIGHTS.relativeVolumePulse * VOLUME_PULSE_RANK[signals.volumePulse] +
    CONFIDENCE_INPUT_WEIGHTS.ponsActivity * PONS_ACTIVITY_RANK[signals.ponsActivity] +
    CONFIDENCE_INPUT_WEIGHTS.recentMomentumStability *
      MOMENTUM_STABILITY_RANK[signals.momentumStability]
  );
}

/**
 * The pair of labels a standing gap earns (§10.2).
 *
 * Two favourite tiers map onto one underdog tier, because §11 draws exactly one
 * distinction with consequences — `UNDERDOG` and `HEAVY_UNDERDOG` earn
 * different upset awards — and inventing a third underdog tier to make the two
 * lists the same length would create a difference the rules never asked for.
 */
function labelsForGap(
  gap: number,
  matchup: ConfidenceCalibration['matchup'],
): readonly [ConfidenceLabel, ConfidenceLabel] {
  if (gap >= matchup.dominant) return ['DOMINANT', 'HEAVY_UNDERDOG'];
  if (gap >= matchup.strongFavorite) return ['STRONG_FAVORITE', 'UNDERDOG'];
  if (gap >= matchup.favored) return ['FAVORED', 'UNDERDOG'];
  if (gap <= -matchup.dominant) return ['HEAVY_UNDERDOG', 'DOMINANT'];
  if (gap <= -matchup.strongFavorite) return ['UNDERDOG', 'STRONG_FAVORITE'];
  if (gap <= -matchup.favored) return ['UNDERDOG', 'FAVORED'];
  return ['EVEN', 'EVEN'];
}

/** Both sides' snapshots, produced together because the label is relative. */
export interface MatchupConfidence {
  readonly left: ConfidenceSnapshot;
  readonly right: ConfidenceSnapshot;
}

/**
 * Snapshots both sides of a matchup (§10.1, §10.2).
 *
 * Both at once, and not one at a time: §10.2 calls these *relative* matchup
 * labels, so a side has no label until it stands opposite someone. A per-ticker
 * `confidenceFor(ticker)` would have to invent an absolute scale, and would
 * give the same stock the same label against a giant and against a minnow.
 */
export function matchupConfidence(
  left: ConfidenceLookback,
  right: ConfidenceLookback,
  calibration: ConfidenceCalibration,
): MatchupConfidence {
  assertCalibration(calibration);

  const leftSignals = subSignals(left, calibration);
  const rightSignals = subSignals(right, calibration);
  const [leftLabel, rightLabel] = labelsForGap(
    standing(leftSignals) - standing(rightSignals),
    calibration.matchup,
  );

  return {
    left: { label: leftLabel, ...leftSignals },
    right: { label: rightLabel, ...rightSignals },
  };
}

/**
 * Rejects a calibration that cannot mean what it says.
 *
 * Checked rather than trusted, because these arrive from configuration (§102)
 * and unordered bands fail quietly: a `strong` below `weak` would label every
 * side `STRONG` and every matchup `EVEN`, which looks like a calm market rather
 * than like a broken setting.
 */
export function assertCalibration(calibration: ConfidenceCalibration): void {
  if (calibration.priceTrend.strong <= calibration.priceTrend.weak) {
    throw new RangeError('Confidence price-trend bands must be ordered: weak < strong');
  }
  if (calibration.volumePulse.rising <= calibration.volumePulse.weak) {
    throw new RangeError('Confidence volume-pulse bands must be ordered: weak < rising');
  }
  if (calibration.ponsActivity.high < calibration.ponsActivity.medium) {
    throw new RangeError('Confidence Pons-activity bands must be ordered: medium <= high');
  }
  const { stable, mixed } = calibration.momentumStability;
  if (!Number.isInteger(stable) || !Number.isInteger(mixed) || stable < 0 || mixed < stable) {
    throw new RangeError('Confidence stability bands must be whole counts with stable <= mixed');
  }
  const { favored, strongFavorite, dominant } = calibration.matchup;
  if (favored <= 0 || strongFavorite <= favored || dominant <= strongFavorite) {
    throw new RangeError(
      'Confidence matchup gaps must be ordered: 0 < favored < strongFavorite < dominant',
    );
  }
  if (dominant > MAX_CONFIDENCE_STANDING) {
    throw new RangeError(
      `A dominant gap of ${String(dominant)} is unreachable; the largest possible gap is ` +
        String(MAX_CONFIDENCE_STANDING),
    );
  }
}
