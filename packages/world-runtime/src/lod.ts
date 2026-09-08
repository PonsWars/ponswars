import { distance, type Vec3 } from './vector.js';
import type { CameraPose, ZoomLevel } from './camera.js';

/**
 * Level-of-detail selection (§37.10, §82.1, §82.2).
 *
 * §37.10 is unusually firm about status: *"LOD is a required performance
 * architecture, not an optional polish item."* Distant sectors get simplified
 * silhouettes, reduced animation and limited particles; the focused sector gets
 * the full unit hierarchy and full VFX.
 *
 * The selection is pure so it can be asserted in a test rather than eyeballed
 * in a running scene.
 */

/** Detail tiers, most to least. */
export const DETAIL_LEVELS = ['FULL', 'REDUCED', 'SILHOUETTE', 'CULLED'] as const;

export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/**
 * Quality tiers (§82.1).
 *
 * *"Quality changes must not affect battle logic."* Nothing this module returns
 * reaches the engine — it decides what to draw, never what is true.
 */
export const QUALITY_TIERS = [
  'ULTRA',
  'HIGH',
  'BALANCED',
  'PERFORMANCE',
  'REDUCED_MOTION',
] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

/**
 * Distance thresholds per tier.
 *
 * `OPEN` production tuning (§59.4: *"final LOD distances"*), so a caller
 * supplies them. A lower tier pulls every threshold inward, which is what makes
 * a weak device draw less rather than draw the same thing badly.
 */
export interface LodThresholds {
  /** Beyond this, a sector drops from FULL to REDUCED. */
  readonly full: number;
  /** Beyond this, REDUCED to SILHOUETTE. */
  readonly reduced: number;
  /** Beyond this, nothing is drawn. */
  readonly silhouette: number;
}

/** Multipliers applied to the thresholds per tier. */
const TIER_SCALE: Readonly<Record<QualityTier, number>> = {
  ULTRA: 1.6,
  HIGH: 1.2,
  BALANCED: 1,
  PERFORMANCE: 0.6,
  // Reduced Motion is about movement, not fidelity, so it keeps the balanced
  // draw distance. §83.3 requires gameplay information to stay complete —
  // hiding sectors from someone who asked for less motion would remove it.
  REDUCED_MOTION: 1,
};

export function scaledThresholds(base: LodThresholds, tier: QualityTier): LodThresholds {
  const factor = TIER_SCALE[tier];
  return {
    full: base.full * factor,
    reduced: base.reduced * factor,
    silhouette: base.silhouette * factor,
  };
}

export interface LodInput {
  readonly camera: CameraPose;
  readonly sectorPosition: Vec3;
  /** True for the sector the player is focused on. */
  readonly isFocused: boolean;
  readonly thresholds: LodThresholds;
  readonly tier: QualityTier;
}

/**
 * Chooses a detail level for one sector.
 *
 * The focused sector is always `FULL`, whatever the distance. §37.10 pairs
 * "distant battles use simplified silhouettes" with "focused battle uses full
 * detail", and a player who has flown out slightly from their own war should
 * not watch it degrade — §36.15 puts their chosen war among the five things
 * that must stay readable at any moment.
 */
export function selectDetail(input: LodInput): DetailLevel {
  if (input.isFocused) {
    return 'FULL';
  }

  const thresholds = scaledThresholds(input.thresholds, input.tier);
  assertOrdered(thresholds);

  const range = distance(input.camera.position, input.sectorPosition);
  if (range <= thresholds.full) return 'FULL';
  if (range <= thresholds.reduced) return 'REDUCED';
  if (range <= thresholds.silhouette) return 'SILHOUETTE';
  return 'CULLED';
}

function assertOrdered(thresholds: LodThresholds): void {
  if (
    thresholds.full <= 0 ||
    thresholds.reduced <= thresholds.full ||
    thresholds.silhouette <= thresholds.reduced
  ) {
    throw new RangeError('LOD thresholds must be positive and strictly increasing');
  }
}

/**
 * What the HUD may show at a zoom level (§37.6, §42.7).
 *
 * *"Information density follows zoom."* Encoded rather than described, so a
 * panel cannot quietly appear at a level the masterplan keeps clear — §42.1
 * makes the world the hero, and the cinematic level fades most HUD to
 * prioritise the event.
 */
export interface HudBudget {
  readonly roundState: boolean;
  readonly countdown: boolean;
  readonly walletSummary: boolean;
  readonly battleSwitcher: boolean;
  readonly battleConfidence: boolean;
  readonly pickControls: boolean;
  readonly warMomentum: boolean;
  readonly deployedCard: boolean;
}

const NOTHING: HudBudget = {
  roundState: false,
  countdown: false,
  walletSummary: false,
  battleSwitcher: false,
  battleConfidence: false,
  pickControls: false,
  warMomentum: false,
  deployedCard: false,
};

export function hudBudgetFor(zoom: ZoomLevel): HudBudget {
  switch (zoom) {
    case 1:
      // Global: round, countdown, five matchups, wallet summary (§42.7).
      return {
        ...NOTHING,
        roundState: true,
        countdown: true,
        walletSummary: true,
        battleSwitcher: true,
      };
    case 2:
      // Sector: confidence, qualitative signals, pick controls.
      return {
        ...NOTHING,
        countdown: true,
        battleSwitcher: true,
        battleConfidence: true,
        pickControls: true,
      };
    case 3:
      // Battlefield: timer, momentum, backing state, deployed card.
      return {
        ...NOTHING,
        countdown: true,
        battleSwitcher: true,
        warMomentum: true,
        deployedCard: true,
      };
    case 4:
      // Cinematic: most HUD fades to prioritise the event (§37.6, §42.7).
      return NOTHING;
  }
}

/**
 * Whether the exact battle score may be rendered at this zoom.
 *
 * Always false. The answer does not depend on zoom at all — §24 and §48.3 keep
 * the score hidden for the whole live battle, and it is revealed on the result
 * screen rather than by flying closer. The function exists so a UI asking
 * "can I show this here?" gets a definite no rather than an absence.
 */
export function mayRenderExactScore(): false {
  return false;
}
