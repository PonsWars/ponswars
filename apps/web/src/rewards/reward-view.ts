import {
  MIN_QUALIFYING_WP,
  qualifiesForDistribution,
  REWARD_WEIGHT_SCALE,
  rewardWeight,
  utcTimestamp,
  type UtcTimestamp,
} from '@ponswars/shared-types';

/**
 * What the Rewards Hub may say, and — more importantly — what it may not (§35).
 *
 * §35.2 is a hard UX rule: while a distribution window is active, PonsWars must
 * **not** show an estimated SPY payout. The final amount depends on the wallet
 * balance at snapshot, the 80% distributable ratio, the number of qualified
 * wallets, every one of their War Points, `sqrt(WP)` weighting, the 2% cap and
 * the redistribution of capped excess — none of which exists yet while the
 * window is open.
 *
 * So the rule is enforced by shape rather than by discipline: the active variant
 * has no allocation field at all. There is nothing for a component to render
 * optimistically, and nothing a later edit can un-hide by deleting a condition.
 */
export type RewardView = ActiveWindowView | FinalizedWindowView;

interface WindowCommon {
  /** Display label, e.g. `REWARDS DISTRIBUTION #042`. */
  readonly label: string;
  /** Window War Points (§16.2 — resets each window, unlike lifetime WP). */
  readonly warPoints: number;
  readonly qualified: boolean;
  /** How many more WP are needed. Zero once qualified. */
  readonly wpToQualify: number;
  /**
   * `sqrt(WP)` to two places, or `null` when the wallet does not qualify.
   *
   * A weight below the floor earns nothing, and showing one anyway invites the
   * reading that a share is already accruing.
   */
  readonly weightLabel: string | null;
}

export interface ActiveWindowView extends WindowCommon {
  readonly kind: 'ACTIVE';
  /**
   * When the 24-hour window closes (§16.2), or `null` when no snapshot has been
   * scheduled yet.
   *
   * §16.2 starts a window's War Points after the previous snapshot, so they
   * accrue whether or not the next one is on the calendar. A countdown to a
   * snapshot nobody has scheduled would be a deadline this product invented.
   */
  readonly closesAt: UtcTimestamp | null;
}

export interface FinalizedWindowView extends WindowCommon {
  readonly kind: 'FINALIZED';
  /**
   * Final SPY allocation, formatted by the caller from base units.
   *
   * Only ever present here, after the Merkle allocation is published (§35.4).
   */
  readonly allocation: string;
  /**
   * Below the minimum claim threshold, so it rolls into the next window
   * (§16.7, §35.5). *"The reward is not lost."*
   */
  readonly carriedForward: boolean;
  /** The wallet hit the 2% per-wallet cap (§16.6, §35.8). */
  readonly capReached: boolean;
}

/** Input for an open window. */
export interface ActiveWindowInput {
  readonly distributionId: number;
  readonly warPoints: number;
  readonly closesAt: UtcTimestamp;
}

/** Input for a published one. */
export interface FinalizedWindowInput {
  readonly distributionId: number;
  readonly warPoints: number;
  readonly allocation: string;
  readonly carriedForward: boolean;
  readonly capReached: boolean;
}

export function activeWindowView(input: ActiveWindowInput): ActiveWindowView {
  return {
    kind: 'ACTIVE',
    ...common(input.distributionId, input.warPoints),
    closesAt: input.closesAt,
  };
}

/**
 * The window a live profile describes (§16.2, §69.9).
 *
 * Labelled by the distribution the operator opened when there is one, and as
 * the current window otherwise — the War Points in it are real either way.
 */
export function currentWindowView(input: {
  readonly warPoints: number;
  /** As the profile contract carries it: epoch milliseconds. */
  readonly window: { readonly distributionId: string; readonly closesAt: number } | null;
}): ActiveWindowView {
  const base = common(0, input.warPoints);
  return {
    kind: 'ACTIVE',
    ...base,
    label:
      input.window === null
        ? 'CURRENT DISTRIBUTION WINDOW'
        : windowLabel(input.window.distributionId),
    closesAt: input.window === null ? null : utcTimestamp(input.window.closesAt),
  };
}

/**
 * A distribution's label, as §35.1 writes it: `REWARDS DISTRIBUTION #042`.
 *
 * Identifiers are whole numbers — the claim contract commits to them — and
 * anything else is shown as it is rather than dressed up as one.
 */
function windowLabel(distributionId: string): string {
  return /^\d+$/.test(distributionId)
    ? `REWARDS DISTRIBUTION #${String(Number(distributionId)).padStart(3, '0')}`
    : `REWARDS DISTRIBUTION ${distributionId}`;
}

export function finalizedWindowView(input: FinalizedWindowInput): FinalizedWindowView {
  return {
    kind: 'FINALIZED',
    ...common(input.distributionId, input.warPoints),
    allocation: input.allocation,
    carriedForward: input.carriedForward,
    capReached: input.capReached,
  };
}

function common(distributionId: number, warPoints: number): WindowCommon {
  if (!Number.isInteger(warPoints) || warPoints < 0) {
    throw new RangeError(
      `War Points must be a non-negative integer, received ${String(warPoints)}`,
    );
  }
  const qualified = qualifiesForDistribution(warPoints);
  return {
    label: `REWARDS DISTRIBUTION #${String(distributionId).padStart(3, '0')}`,
    warPoints,
    qualified,
    wpToQualify: qualified ? 0 : MIN_QUALIFYING_WP - warPoints,
    weightLabel: qualified ? formatRewardWeight(rewardWeight(warPoints)) : null,
  };
}

/**
 * Formats a scaled reward weight to two decimal places.
 *
 * Integer arithmetic throughout: `rewardWeight` returns `sqrt(WP)` scaled by
 * `1e9` precisely so no float ever touches it (§66.3, ADR 0003), and dividing it
 * back into a `number` here to call `toFixed` would undo that at the last step.
 * Rounds half up, which is what makes `sqrt(84) = 9.16515…` display as the
 * `9.17` §35.2 gives as its example.
 */
export function formatRewardWeight(scaledWeight: bigint): string {
  if (scaledWeight < 0n) {
    throw new RangeError('A reward weight is never negative');
  }
  const perHundredth = REWARD_WEIGHT_SCALE / 100n;
  const hundredths = (scaledWeight + perHundredth / 2n) / perHundredth;
  const whole = hundredths / 100n;
  const fraction = hundredths % 100n;
  return `${String(whole)}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Formats a remaining duration as `hh:mm:ss`.
 *
 * The distribution window is twenty-four hours (§16.2), so minutes and seconds
 * alone would wrap around and read as a far shorter wait. Clamped at zero for
 * the same reason the round countdown is: a negative value shows a passed
 * deadline as though it were still ahead.
 */
export function formatWindowCountdown(remainingMs: number): string {
  const clamped = remainingMs > 0 ? remainingMs : 0;
  const totalSeconds = Math.floor(clamped / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

// ---------------------------------------------------------------------------
// Claim flow (§35.6)
// ---------------------------------------------------------------------------

/**
 * The user-facing claim state machine (§35.6).
 *
 * `READY_TO_CLAIM → CONFIRM_IN_WALLET → SUBMITTING → CONFIRMED`, with `FAILED`
 * reachable from the two steps that can actually fail.
 */
export const CLAIM_STATES = [
  'READY_TO_CLAIM',
  'CONFIRM_IN_WALLET',
  'SUBMITTING',
  'CONFIRMED',
  'FAILED',
] as const;

export type ClaimState = (typeof CLAIM_STATES)[number];

/**
 * Legal claim transitions.
 *
 * `FAILED` leads back to `READY_TO_CLAIM` and nowhere else. §35.6 is explicit
 * that *"a failed user transaction must never destroy or mutate the underlying
 * entitlement"* — the allocation is a published Merkle leaf, and a rejected
 * wallet signature has no bearing on it. Modelling failure as terminal would
 * make the UI claim otherwise.
 */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimState, readonly ClaimState[]>> = {
  READY_TO_CLAIM: ['CONFIRM_IN_WALLET'],
  CONFIRM_IN_WALLET: ['SUBMITTING', 'FAILED'],
  SUBMITTING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: ['READY_TO_CLAIM'],
} as const;

export function canTransitionClaim(from: ClaimState, to: ClaimState): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export interface ClaimCopy {
  readonly headline: string;
  readonly detail: string | null;
  /** Whether the player can act right now. */
  readonly actionable: boolean;
}

export function claimCopy(state: ClaimState): ClaimCopy {
  switch (state) {
    case 'READY_TO_CLAIM':
      return { headline: 'READY TO CLAIM', detail: null, actionable: true };
    case 'CONFIRM_IN_WALLET':
      return {
        headline: 'CONFIRM IN WALLET',
        detail: 'Approve the transaction in your wallet.',
        actionable: false,
      };
    case 'SUBMITTING':
      return { headline: 'SUBMITTING', detail: 'Waiting for confirmation.', actionable: false };
    case 'CONFIRMED':
      return { headline: 'CLAIMED', detail: null, actionable: false };
    case 'FAILED':
      // The exact wording §35.6 asks for. It says what did not happen and what
      // is still true, in that order.
      return {
        headline: 'CLAIM NOT COMPLETED',
        detail: 'Your allocation is still available. Try again.',
        actionable: true,
      };
  }
}
