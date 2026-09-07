import { minutes, type DurationMs } from './time.js';

/**
 * Battle Confidence — pre-battle screening intelligence (§10).
 *
 * Confidence is **not** a probability of winning. §10 forbids showing an exact
 * percentage, Guide §7.1 lists `NVDA 67% vs AAPL 33%` as a mockup error to
 * correct, and a delivered PNG contains one. It is snapshotted when the round
 * opens, never enters the Battle Score, and stops influencing anything at lock.
 */

/**
 * Confidence is qualitative. Nothing in this module produces a percentage, and
 * nothing downstream may derive one from it.
 */
export const CONFIDENCE_IS_PROBABILITY = false;

/** The rolling window sampled before Pick Phase opens (§10.1). */
export const CONFIDENCE_LOOKBACK: DurationMs = minutes(15);

/** Weighted inputs, snapshotted at round open (§10.1). */
export const CONFIDENCE_INPUTS = [
  'recentPriceTrend',
  'relativeVolumePulse',
  'ponsActivity',
  'recentMomentumStability',
] as const;

export type ConfidenceInput = (typeof CONFIDENCE_INPUTS)[number];

/**
 * Input weights (§10.1): 40 / 25 / 20 / 15, summing to 100.
 *
 * Note these are **not** the battle score weights (§12). Confidence screens a
 * matchup beforehand; the score decides it afterwards from a fresh nine-minute
 * window. Conflating the two would make a pre-battle favourite structurally
 * likelier to win, which §10.3 explicitly rules out.
 */
export const CONFIDENCE_INPUT_WEIGHTS: Readonly<Record<ConfidenceInput, number>> = {
  recentPriceTrend: 40,
  relativeVolumePulse: 25,
  ponsActivity: 20,
  recentMomentumStability: 15,
} as const;

/**
 * Relative matchup labels (§10.2).
 *
 * Ordered from weakest to strongest standing so a UI can rank them without
 * inventing an ordering of its own.
 */
export const CONFIDENCE_LABELS = [
  'HEAVY_UNDERDOG',
  'UNDERDOG',
  'EVEN',
  'FAVORED',
  'STRONG_FAVORITE',
  'DOMINANT',
] as const;

export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

/**
 * Labels that mark a side as an underdog, and so qualify a win for upset
 * War Points (§11).
 */
export const UNDERDOG_LABELS = [
  'UNDERDOG',
  'HEAVY_UNDERDOG',
] as const satisfies readonly ConfidenceLabel[];

export type UnderdogLabel = (typeof UNDERDOG_LABELS)[number];

export function isUnderdogLabel(label: ConfidenceLabel): label is UnderdogLabel {
  return (UNDERDOG_LABELS as readonly ConfidenceLabel[]).includes(label);
}

// ---------------------------------------------------------------------------
// Qualitative sub-signals (§10.2)
// ---------------------------------------------------------------------------

export const PRICE_TREND_SIGNALS = ['STRONG', 'MIXED', 'WEAK'] as const;
export const VOLUME_PULSE_SIGNALS = ['RISING', 'NORMAL', 'WEAK'] as const;
export const PONS_ACTIVITY_SIGNALS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const MOMENTUM_STABILITY_SIGNALS = ['STABLE', 'MIXED', 'UNSTABLE'] as const;

export type PriceTrendSignal = (typeof PRICE_TREND_SIGNALS)[number];
export type VolumePulseSignal = (typeof VOLUME_PULSE_SIGNALS)[number];
export type PonsActivitySignal = (typeof PONS_ACTIVITY_SIGNALS)[number];
export type MomentumStabilitySignal = (typeof MOMENTUM_STABILITY_SIGNALS)[number];

/**
 * One side's pre-battle intel, exactly as a client may render it (§27.5).
 *
 * Carries no numeric score and no percentage — only the label and the four
 * qualitative sub-signals.
 */
export interface ConfidenceSnapshot {
  readonly label: ConfidenceLabel;
  readonly priceTrend: PriceTrendSignal;
  readonly volumePulse: VolumePulseSignal;
  readonly ponsActivity: PonsActivitySignal;
  readonly momentumStability: MomentumStabilitySignal;
}
