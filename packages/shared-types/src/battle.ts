import type { BattleId, RoundId, SectorId } from './ids.js';
import type { ActiveTicker } from './roster.js';
import type { DurationMs, UtcTimestamp } from './time.js';

/**
 * Battle scoring, momentum presentation and the public realtime payload.
 *
 * Masterplan §12 (score engine), §13 (pixel battle behaviour), §15 (card
 * visuals), §24 and §48 (realtime delivery).
 */

// ---------------------------------------------------------------------------
// Score engine — LOCKED (§12)
// ---------------------------------------------------------------------------

/** Each battle resolves to exactly 100 battle points shared between two stocks. */
export const BATTLE_SCORE_TOTAL = 100;

/** The four scoring components, in masterplan order. */
export const BATTLE_SCORE_COMPONENTS = [
  'priceMomentum',
  'relativeVolume',
  'ponsPower',
  'holderCardSupport',
] as const;

export type BattleScoreComponent = (typeof BATTLE_SCORE_COMPONENTS)[number];

/**
 * Component weights (§12).
 *
 * *"No component may steal weight from another component."* These four sum to
 * exactly {@link BATTLE_SCORE_TOTAL}, and a test asserts it.
 */
export const BATTLE_SCORE_WEIGHTS: Readonly<Record<BattleScoreComponent, number>> = {
  priceMomentum: 45,
  relativeVolume: 25,
  ponsPower: 20,
  holderCardSupport: 10,
} as const;

/**
 * Pons Power composition (§12.3): 70% qualified activity, 30% unique active
 * wallets, both passed through diminishing contribution so one whale or spam
 * pattern cannot linearly dominate.
 */
export const PONS_POWER_COMPOSITION = {
  qualifiedActivity: 70,
  uniqueActiveWallets: 30,
} as const;

/**
 * Channels through which Holder Card Support enters the score (§12.4).
 *
 * General is distributed proportionally across the other three, broadly
 * following the base battle weighting.
 */
export const CARD_SUPPORT_CHANNELS = ['market', 'volume', 'pons', 'general'] as const;

export type CardSupportChannel = (typeof CARD_SUPPORT_CHANNELS)[number];

/**
 * Hard cap on aggregate Holder Card Support, in battle points (§12.4).
 *
 * *"Cards may tilt close wars but cannot overpower real market behavior."*
 * Diminishing returns are applied before this cap so 4x raw support does not
 * produce 4x influence.
 */
export const CARD_SUPPORT_MAX_POINTS = BATTLE_SCORE_WEIGHTS.holderCardSupport;

/**
 * Tiebreak order (§12.7).
 *
 * The final step is a deterministic chain-derived tiebreak from the finalized
 * block hash plus the battle ID. There is no manual admin winner selection at
 * any point in this list.
 */
export const TIEBREAK_ORDER = [
  'priceMomentum',
  'relativeVolume',
  'ponsPower',
  'chainDerived',
] as const;

export type TiebreakStep = (typeof TIEBREAK_ORDER)[number];

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

/**
 * Which staging area a faction occupies in its sector.
 *
 * Purely positional. Neither side carries an advantage, and a sector belongs
 * to no faction (§38.3).
 */
export const BATTLE_SIDES = ['LEFT', 'RIGHT'] as const;

export type BattleSide = (typeof BATTLE_SIDES)[number];

export function opposingSide(side: BattleSide): BattleSide {
  return side === 'LEFT' ? 'RIGHT' : 'LEFT';
}

// ---------------------------------------------------------------------------
// Momentum presentation — LOCKED labels (§13.3)
// ---------------------------------------------------------------------------

/**
 * Qualitative War Momentum states.
 *
 * This is what the public stream carries instead of the score (§12.5, §48.3).
 * `COMEBACK` is history-dependent — it describes a reversal, not a position —
 * so it cannot be derived from the current frontline alone.
 */
export const MOMENTUM_STATES = [
  'CONTESTED',
  'PUSHING',
  'SURGING',
  'DOMINATING',
  'COMEBACK',
] as const;

export type MomentumState = (typeof MOMENTUM_STATES)[number];

/**
 * Normalized frontline position: the share of the field held by the LEFT
 * faction, in `[0, 1]`.
 *
 * `0.5` is a contested centre. Higher means LEFT is pushing.
 */
export type NormalizedFrontline = number;

/**
 * The frontline anchors §13.1 states, as *approximate* visual reference points.
 *
 * Deliberately not a threshold table. The masterplan gives these as rough
 * mappings and `docs/OPEN_PARAMETERS.md` keeps band edges under calibration —
 * publishing exact edges here would dress a tuning constant up as a locked
 * rule, which §102 forbids.
 */
export const FRONTLINE_REFERENCE_POINTS = [
  { share: 0.5, reads: 'contested near centre' },
  { share: 0.55, reads: 'slight sustained push' },
  { share: 0.6, reads: 'clear pressure, territorial gain' },
  { share: 0.7, reads: 'dominant push' },
  { share: 0.9, reads: 'near-collapse' },
] as const;

/**
 * Visual intensity of the battlefield, normalized to `[0, 1]`.
 *
 * Drives attack frequency, projectile density and environmental energy. It is
 * presentation state: §13.3 is explicit that momentum must not simply multiply
 * the winning side's troop count, and none of it feeds the score.
 */
export type Intensity = number;

/**
 * Cosmetic battlefield events (§13.4).
 *
 * *"These are visual only and never alter Battle Score."*
 */
export const VISUAL_EVENT_CUES = [
  'CHARGE',
  'ARTILLERY_BARRAGE',
  'COUNTERATTACK',
  'DEFENSIVE_WALL_BREAK',
  'REINFORCEMENT_ARRIVAL',
  'RAPID_PUSH',
  'CLOSE_QUARTERS_CLASH',
] as const;

export type VisualEventCue = (typeof VISUAL_EVENT_CUES)[number];

/**
 * Aggregate community card support, summarized for display (§15).
 *
 * *"Thousands of deployed cards must not equal thousands of literal extra
 * units."* The client receives a tier, never a raw count.
 */
export const CARD_SUPPORT_TIERS = ['LOW', 'MEDIUM', 'HIGH', 'MAX'] as const;

export type CardSupportTier = (typeof CARD_SUPPORT_TIERS)[number];

// ---------------------------------------------------------------------------
// Victory classification — LOCKED (§13.6, §11)
// ---------------------------------------------------------------------------

export const VICTORY_LABELS = [
  'NARROW_VICTORY',
  'VICTORY',
  'DECISIVE_VICTORY',
  'UPSET_VICTORY',
  'MAJOR_UPSET',
  'COMEBACK_VICTORY',
] as const;

export type VictoryLabel = (typeof VICTORY_LABELS)[number];

// ---------------------------------------------------------------------------
// Realtime payloads
// ---------------------------------------------------------------------------

/**
 * Public feed health as exposed to clients (§48.3).
 *
 * Coarser than the internal {@link import('./feed.js').FeedHealth} so a client
 * can honestly say "data is degraded" without leaking which vendor is failing.
 */
export const PUBLIC_FEED_HEALTH = ['HEALTHY', 'DEGRADED'] as const;

export type PublicFeedHealth = (typeof PUBLIC_FEED_HEALTH)[number];

/**
 * The `BATTLE_STATE_UPDATE` payload (§48.3).
 *
 * **This type deliberately has no score field, and must never gain one.**
 * §24 and §48.3 both state it directly: *"Do not send the hidden exact score
 * during a live battle just because the client needs animation state."*
 * Guide §7.2 lists a live exact score as a mockup error, and three delivered
 * PNGs contain one — so the constraint is enforced here in the type rather than
 * left to reviewer memory. The exact breakdown lives in
 * {@link FinalizedBattleResult}, which only exists after finalization.
 */
export interface PublicBattleStateUpdate {
  readonly battleId: BattleId;
  readonly serverTime: UtcTimestamp;
  /** Floored at zero; never negative (§23.5). */
  readonly timeRemaining: DurationMs;
  readonly momentum: MomentumState;
  readonly frontline: NormalizedFrontline;
  readonly intensity: Intensity;
  readonly cardSupport: CardSupportTier;
  readonly feedHealth: PublicFeedHealth;
  /** Present only when a cosmetic event fires on this tick. */
  readonly visualEvent?: VisualEventCue;
}

/** One side's four component scores, summing to that side's share of 100. */
export interface BattleScoreBreakdown {
  readonly priceMomentum: number;
  readonly relativeVolume: number;
  readonly ponsPower: number;
  readonly holderCardSupport: number;
}

/** A matchup as scheduled for a round (§4.3). */
export interface BattleMatchup {
  readonly battleId: BattleId;
  readonly roundId: RoundId;
  readonly sectorId: SectorId;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
}

/**
 * The finalized, immutable result of a battle (§49.9).
 *
 * Carries the evidence needed to answer *"why did this stock win this specific
 * round?"* without re-deriving it: both breakdowns, the victory label, whether
 * a tiebreak ran, and the scoring-engine version that produced it.
 */
export interface FinalizedBattleResult {
  readonly battleId: BattleId;
  readonly roundId: RoundId;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  readonly winner: ActiveTicker;
  readonly leftScore: BattleScoreBreakdown;
  readonly rightScore: BattleScoreBreakdown;
  readonly victoryLabel: VictoryLabel;
  /** The step that decided the battle, when the totals tied (§12.7). */
  readonly tiebreakStep?: TiebreakStep;
  /** Versions the result so historical battles stay reproducible (§66.4). */
  readonly scoringEngineVersion: string;
  readonly finalizedAt: UtcTimestamp;
  /** Hash of the evidence bundle this result is reproducible from (§26). */
  readonly evidenceHash: string;
}

/** Sums a breakdown into that side's share of the 100 total points. */
export function totalScore(breakdown: BattleScoreBreakdown): number {
  return (
    breakdown.priceMomentum +
    breakdown.relativeVolume +
    breakdown.ponsPower +
    breakdown.holderCardSupport
  );
}
