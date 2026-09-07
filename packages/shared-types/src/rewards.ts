import { isUnderdogLabel, type ConfidenceLabel } from './confidence.js';
import { basisPoints, integerSqrt, type BasisPoints } from './money.js';
import { hours, type DurationMs } from './time.js';

/**
 * War Points and the 24-hour Rewards Distribution.
 *
 * Masterplan §11 (War Points), §16 (distribution), §17 (Merkle claims).
 */

// ---------------------------------------------------------------------------
// War Points — LOCKED (§11)
// ---------------------------------------------------------------------------

/**
 * Reasons a War Point award is written.
 *
 * These double as the idempotency dimension of the ledger: §49.10 requires that
 * the same reason for the same wallet and battle can never be applied twice.
 */
export const WP_AWARD_REASONS = [
  'WIN',
  'UNDERDOG_WIN',
  'HEAVY_UNDERDOG_WIN',
  'CARD_ASSIST',
] as const;

export type WpAwardReason = (typeof WP_AWARD_REASONS)[number];

/** Award values (§11). */
export const WP_AWARDS: Readonly<Record<WpAwardReason, number>> = {
  WIN: 10,
  UNDERDOG_WIN: 12,
  HEAVY_UNDERDOG_WIN: 14,
  CARD_ASSIST: 2,
} as const;

/**
 * The award a winning pick earns, from the winner's pre-battle confidence.
 *
 * Confidence is snapshotted at round open and frozen at lock (§10.3), so this
 * reads a recorded label rather than anything computed during the battle.
 */
export function baseWpAwardReason(winnerConfidence: ConfidenceLabel): WpAwardReason {
  if (winnerConfidence === 'HEAVY_UNDERDOG') return 'HEAVY_UNDERDOG_WIN';
  if (winnerConfidence === 'UNDERDOG') return 'UNDERDOG_WIN';
  return 'WIN';
}

/**
 * Total War Points for a winning pick.
 *
 * A loss earns nothing, and a VOID earns nothing while also recording no loss
 * and refunding the deployed card (§4.4, §11) — both are the absence of an
 * award rather than a value this function returns.
 */
export function winningPickWp(winnerConfidence: ConfidenceLabel, cardDeployed: boolean): number {
  const base = WP_AWARDS[baseWpAwardReason(winnerConfidence)];
  return cardDeployed ? base + WP_AWARDS.CARD_ASSIST : base;
}

/** Upset labels applied to a result for display (§11). */
export function upsetLabelFor(
  winnerConfidence: ConfidenceLabel,
): 'MAJOR_UPSET' | 'UPSET_VICTORY' | null {
  if (winnerConfidence === 'HEAVY_UNDERDOG') return 'MAJOR_UPSET';
  if (winnerConfidence === 'UNDERDOG') return 'UPSET_VICTORY';
  return null;
}

/** True when a win over this confidence counts as an upset (§11). */
export function isUpset(winnerConfidence: ConfidenceLabel): boolean {
  return isUnderdogLabel(winnerConfidence);
}

// ---------------------------------------------------------------------------
// Distribution — LOCKED (§16)
// ---------------------------------------------------------------------------

/** Distribution cadence (§16.2). */
export const DISTRIBUTION_WINDOW: DurationMs = hours(24);

/** Minimum current-window War Points to participate (§16.4). */
export const MIN_QUALIFYING_WP = 50;

/** Share of the pool distributed at snapshot (§16.3). */
export const POOL_DISTRIBUTABLE_BPS: BasisPoints = basisPoints(8_000);

/** Share retained as buffer and carryover (§16.3). */
export const POOL_CARRYOVER_BPS: BasisPoints = basisPoints(2_000);

/** Maximum share a single wallet may receive; excess is redistributed (§16.6). */
export const PER_WALLET_CAP_BPS: BasisPoints = basisPoints(200);

/**
 * Minimum claim threshold — **BASELINE, not locked** (§16.7).
 *
 * The masterplan gives `0.001 SPY` as an example still to be confirmed, and
 * `docs/OPEN_PARAMETERS.md` tracks it as `BASELINE`. The name says so, and the
 * runtime value must come from validated configuration: amounts below the
 * threshold carry forward rather than forcing dust claims, so the exact figure
 * is a product decision about who gets paid this window.
 */
export const MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL = '0.001';

/**
 * Fixed-point scale for reward weights.
 *
 * `sqrt(WP)` is irrational for most WP values, so the weight is carried as a
 * scaled integer instead of a float. Nine decimal places is far finer than any
 * plausible pool division and keeps every downstream ratio in exact `bigint`
 * arithmetic (§66.3, §66.4).
 */
export const REWARD_WEIGHT_SCALE = 1_000_000_000n;

/**
 * Reward weight for a wallet's window War Points: `sqrt(WP)`, scaled (§16.5).
 *
 * Computed as `integerSqrt(wp * SCALE²)`, which is the scaled square root
 * without ever forming an irrational intermediate. Diminishing by design — ten
 * times the War Points earns about three times the weight, not ten.
 *
 * @throws RangeError if `warPoints` is not a non-negative integer.
 */
export function rewardWeight(warPoints: number): bigint {
  if (!Number.isInteger(warPoints) || warPoints < 0) {
    throw new RangeError(
      `War Points must be a non-negative integer, received ${String(warPoints)}`,
    );
  }
  return integerSqrt(BigInt(warPoints) * REWARD_WEIGHT_SCALE * REWARD_WEIGHT_SCALE);
}

/** True when a wallet's window War Points meet the qualification floor (§16.4). */
export function qualifiesForDistribution(windowWarPoints: number): boolean {
  return windowWarPoints >= MIN_QUALIFYING_WP;
}

// ---------------------------------------------------------------------------
// Claim lifecycle
// ---------------------------------------------------------------------------

/**
 * States a wallet's allocation moves through (§16.8, §17).
 *
 * `CARRIED_FORWARD` is the below-threshold path (§16.7): the amount is not
 * forfeited, it rolls into the next window. Funding is manual, calculation is
 * automated, claiming is user-driven.
 */
export const REWARD_ALLOCATION_STATES = [
  'CALCULATED',
  'PUBLISHED',
  'CLAIMED',
  'CARRIED_FORWARD',
] as const;

export type RewardAllocationState = (typeof REWARD_ALLOCATION_STATES)[number];

/**
 * Distribution window lifecycle (§16.2, §17).
 *
 * A published root is immutable and admin may not edit individual rewards
 * afterwards (§17), so `PUBLISHED` and `CLOSED` never transition backwards.
 */
export const DISTRIBUTION_STATES = [
  'OPEN',
  'SNAPSHOT',
  'CALCULATED',
  'PUBLISHED',
  'CLOSED',
] as const;

export type DistributionState = (typeof DISTRIBUTION_STATES)[number];

export const DISTRIBUTION_TRANSITIONS: Readonly<
  Record<DistributionState, readonly DistributionState[]>
> = {
  OPEN: ['SNAPSHOT'],
  SNAPSHOT: ['CALCULATED'],
  CALCULATED: ['PUBLISHED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: [],
} as const;

export function canTransitionDistribution(from: DistributionState, to: DistributionState): boolean {
  return DISTRIBUTION_TRANSITIONS[from].includes(to);
}
