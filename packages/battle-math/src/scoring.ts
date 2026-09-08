import {
  BATTLE_SCORE_COMPONENTS,
  BATTLE_SCORE_WEIGHTS,
  FULL_BATTLE_SCORE_SCALED,
  integerSqrt,
  PONS_POWER_COMPOSITION,
  type BattleScoreComponent,
} from '@ponswars/shared-types';
import { clampUnit, divScaled, points, RATIO_SCALE } from './scale.js';

/**
 * The battle score engine (§12).
 *
 * One hundred points shared between two stocks, allocated 45 / 25 / 20 / 10
 * across price momentum, relative volume, Pons power and holder card support.
 * *"No component may steal weight from another component."*
 *
 * Every component reduces to a single **edge** — a signed, bounded measure of
 * how far ahead one side is on that input — and every edge is split by the same
 * primitive. See ADR 0005 for why the split is piecewise-linear and clamped
 * rather than a logistic curve.
 *
 * All arithmetic is `bigint` at a fixed scale (§66.4). Nothing here is a float,
 * so a replay months later reproduces the result exactly rather than closely.
 */

/**
 * Sensitivity constants, one per component.
 *
 * These are `CALIBRATE` in `docs/OPEN_PARAMETERS.md`: §12 locks the structure —
 * the weights, the volatility adjustment, the relative-volume ratio, the 70/30
 * Pons composition, the diminishing card returns — while §59.2 leaves the
 * constants inside them open. They are therefore an **input**, never a compiled
 * default, so no engineer can ship a calibration as product policy (§102).
 *
 * Each divisor is the edge at which a component saturates: with
 * `priceEdgeDivisor` at `2.0`, a two-sigma advantage in volatility-adjusted
 * return takes the full 45 points.
 */
export interface ScoringCalibration {
  /** Volatility-adjusted return difference that saturates price momentum. */
  readonly priceEdgeDivisor: bigint;
  /** Relative-volume difference that saturates the volume component. */
  readonly volumeEdgeDivisor: bigint;
  /** Normalized Pons difference that saturates Pons power. */
  readonly ponsEdgeDivisor: bigint;
  /** Normalized card-support difference that saturates card support. */
  readonly cardEdgeDivisor: bigint;
}

/** Aggregate card support for one side, in tenths of a support unit. */
export interface AggregateCardSupport {
  readonly market: bigint;
  readonly volume: bigint;
  readonly pons: bigint;
  readonly general: bigint;
}

export const NO_CARD_SUPPORT: AggregateCardSupport = {
  market: 0n,
  volume: 0n,
  pons: 0n,
  general: 0n,
};

/** Everything the engine needs about one side of a battle. */
export interface SideInputs {
  /**
   * Return over the battle window, scaled. `10_000n` is +1%.
   *
   * The window opens exactly at lock and closes at the hard cutoff (§12.1).
   */
  readonly windowReturn: bigint;
  /**
   * The asset's own recent volatility, scaled and strictly positive.
   *
   * Dividing by it is what stops a naturally volatile asset gaining a
   * structural advantage purely because it moves more (§12.1).
   */
  readonly volatility: bigint;
  /**
   * Cumulative window volume over the expected volume for the same elapsed
   * comparable window, scaled. `1_000_000n` is exactly as expected (§12.2).
   *
   * Never a raw share count: §12.2 forbids comparing absolute volume across
   * tickers, and this ratio is what makes the comparison meaningful.
   */
  readonly relativeVolume: bigint;
  /** Qualified Pons activity events, already filtered for abuse (§12.3). */
  readonly qualifiedPonsActivity: bigint;
  /** Unique active wallets over the window (§12.3). */
  readonly uniqueActiveWallets: bigint;
  /** Aggregate community card support, snapshotted at lock (§23.1). */
  readonly cardSupport: AggregateCardSupport;
}

/** Scaled points for one side across the four components. */
export interface ScaledBreakdown {
  readonly priceMomentum: bigint;
  readonly relativeVolume: bigint;
  readonly ponsPower: bigint;
  readonly holderCardSupport: bigint;
}

export interface BattleScore {
  readonly left: ScaledBreakdown;
  readonly right: ScaledBreakdown;
  /** Scaled total for each side. The two always sum to exactly 100 points. */
  readonly leftTotal: bigint;
  readonly rightTotal: bigint;
  /** The edges the split came from, retained as audit evidence (§26). */
  readonly edges: Readonly<Record<BattleScoreComponent, bigint>>;
}

/**
 * Splits a component's weight according to a signed edge.
 *
 * `edge` is clamped to `[-1, +1]`; `+1` gives the left side the whole weight,
 * `0` splits it evenly, `-1` gives it all to the right.
 *
 * The right side is computed as `weight - left` rather than by a second
 * division, so the two halves sum to exactly the component weight for every
 * possible input. That is what keeps the four components summing to exactly
 * 100 points with no rounding drift — the property §12 depends on.
 */
export function splitByEdge(weightScaled: bigint, edge: bigint): { left: bigint; right: bigint } {
  const clamped = clampUnit(edge);
  const left = (weightScaled * (RATIO_SCALE + clamped)) / (2n * RATIO_SCALE);
  return { left, right: weightScaled - left };
}

/**
 * Edge between two non-negative strengths, normalized by a divisor.
 *
 * Returns zero when both sides are zero: no signal is a tie, not a win for
 * whichever side the arithmetic happens to favour.
 */
function edgeFromDifference(left: bigint, right: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) {
    throw new RangeError('Calibration divisor must be positive');
  }
  if (left === right) {
    return 0n;
  }
  return clampUnit(divScaled(left - right, divisor));
}

/**
 * Volatility-adjusted return (§12.1).
 *
 * @throws RangeError if volatility is not strictly positive — a zero baseline
 *   would make the adjustment meaningless and the division undefined.
 */
export function volatilityAdjustedReturn(side: SideInputs): bigint {
  if (side.volatility <= 0n) {
    throw new RangeError('Volatility baseline must be strictly positive');
  }
  return divScaled(side.windowReturn, side.volatility);
}

/**
 * Normalized Pons strength: 70% qualified activity, 30% unique wallets (§12.3).
 *
 * Both inputs pass through an integer square root first. §12.3 requires
 * *"normalized / diminishing contribution logic so one whale or spam pattern
 * cannot linearly dominate"*, and a square root is the diminishing transform
 * that costs nothing in determinism — `integerSqrt` is exact `bigint`.
 */
export function ponsStrength(side: SideInputs): bigint {
  if (side.qualifiedPonsActivity < 0n || side.uniqueActiveWallets < 0n) {
    throw new RangeError('Pons counts must not be negative');
  }
  const activity = integerSqrt(side.qualifiedPonsActivity * RATIO_SCALE * RATIO_SCALE);
  const wallets = integerSqrt(side.uniqueActiveWallets * RATIO_SCALE * RATIO_SCALE);
  return (
    (activity * BigInt(PONS_POWER_COMPOSITION.qualifiedActivity) +
      wallets * BigInt(PONS_POWER_COMPOSITION.uniqueActiveWallets)) /
    100n
  );
}

/**
 * Normalized card support strength (§12.4).
 *
 * General support is distributed across the three scoring channels in
 * proportion to the base battle weighting, then the channels are recombined
 * under that same weighting — *"channel emphasis should broadly follow the base
 * battle weighting"*.
 *
 * The result passes through a square root, so four times the raw support does
 * not produce four times the influence. Combined with the component's 10-point
 * ceiling, this is what keeps cards able to tilt a close war without
 * overpowering real market behaviour.
 */
export function cardSupportStrength(support: AggregateCardSupport): bigint {
  const { market, volume, pons, general } = support;
  if (market < 0n || volume < 0n || pons < 0n || general < 0n) {
    throw new RangeError('Card support must not be negative');
  }

  const marketWeight = BigInt(BATTLE_SCORE_WEIGHTS.priceMomentum);
  const volumeWeight = BigInt(BATTLE_SCORE_WEIGHTS.relativeVolume);
  const ponsWeight = BigInt(BATTLE_SCORE_WEIGHTS.ponsPower);
  const channelTotal = marketWeight + volumeWeight + ponsWeight;

  // General spreads across the three channels proportionally, so a General
  // charge is worth the same as an equal charge aimed at a specific channel.
  const effective =
    (market + (general * marketWeight) / channelTotal) * marketWeight +
    (volume + (general * volumeWeight) / channelTotal) * volumeWeight +
    (pons + (general * ponsWeight) / channelTotal) * ponsWeight;

  const normalized = effective / channelTotal;
  return integerSqrt(normalized * RATIO_SCALE * RATIO_SCALE);
}

/**
 * Scores a battle.
 *
 * Pure and deterministic. The same inputs and calibration always produce the
 * same breakdown, which is what makes §26 evidence reproducible.
 */
export function scoreBattle(
  left: SideInputs,
  right: SideInputs,
  calibration: ScoringCalibration,
): BattleScore {
  const priceEdge = edgeFromDifference(
    volatilityAdjustedReturn(left),
    volatilityAdjustedReturn(right),
    calibration.priceEdgeDivisor,
  );
  const volumeEdge = edgeFromDifference(
    left.relativeVolume,
    right.relativeVolume,
    calibration.volumeEdgeDivisor,
  );
  const ponsEdge = edgeFromDifference(
    ponsStrength(left),
    ponsStrength(right),
    calibration.ponsEdgeDivisor,
  );
  const cardEdge = edgeFromDifference(
    cardSupportStrength(left.cardSupport),
    cardSupportStrength(right.cardSupport),
    calibration.cardEdgeDivisor,
  );

  const price = splitByEdge(points(BATTLE_SCORE_WEIGHTS.priceMomentum), priceEdge);
  const volume = splitByEdge(points(BATTLE_SCORE_WEIGHTS.relativeVolume), volumeEdge);
  const pons = splitByEdge(points(BATTLE_SCORE_WEIGHTS.ponsPower), ponsEdge);
  const cards = splitByEdge(points(BATTLE_SCORE_WEIGHTS.holderCardSupport), cardEdge);

  const leftBreakdown: ScaledBreakdown = {
    priceMomentum: price.left,
    relativeVolume: volume.left,
    ponsPower: pons.left,
    holderCardSupport: cards.left,
  };
  const rightBreakdown: ScaledBreakdown = {
    priceMomentum: price.right,
    relativeVolume: volume.right,
    ponsPower: pons.right,
    holderCardSupport: cards.right,
  };

  return {
    left: leftBreakdown,
    right: rightBreakdown,
    leftTotal: totalOf(leftBreakdown),
    rightTotal: totalOf(rightBreakdown),
    edges: {
      priceMomentum: priceEdge,
      relativeVolume: volumeEdge,
      ponsPower: ponsEdge,
      holderCardSupport: cardEdge,
    },
  };
}

/** Sums a scaled breakdown. */
export function totalOf(breakdown: ScaledBreakdown): bigint {
  return BATTLE_SCORE_COMPONENTS.reduce((sum, component) => sum + breakdown[component], 0n);
}

/** The scaled value of the full hundred points. */
/**
 * The whole score, scaled.
 *
 * Re-exported from `@ponswars/shared-types` for the same reason `POINT_SCALE`
 * is: the value describes how a score is represented where it crosses a
 * boundary, and one definition is the only way two of them stay equal.
 */
export const FULL_SCORE_SCALED = FULL_BATTLE_SCORE_SCALED;
