import type { CardSupportTier } from '@ponswars/shared-types';
import type { DetailLevel } from '@ponswars/world-runtime';

/**
 * Two readings the engine sends with every tick, turned into how a battle looks
 * (§13, §15, §40).
 *
 * Both were on every `BATTLE_STATE_UPDATE` from the start, and the client
 * dropped both. The fire crossing a battlefield ran at one density whatever
 * the fighting was doing, and community card support — the one thing a
 * player's Genesis card contributes to what everyone else sees — did not show
 * anywhere at all.
 *
 * Pure, so the two rules can be read and tested apart from the scene.
 */

/**
 * How much of a side's fire is in the air, from the engine's intensity.
 *
 * `intensity` is the engine's reading of how hard the battle is being fought —
 * from how far the frontline stands from even and how fast it is moving — and
 * §13 gives it attack frequency and projectile density to drive. This is that,
 * directly: a share of the rounds a detail level allows.
 *
 * Never below a floor while the battle is live. A contested, level battle is
 * still a battle, and fire that stopped whenever nobody was pushing would read
 * as the fighting having stopped. Before the first update says anything, the
 * floor is what it gets — not a guess dressed as a reading.
 *
 * Presentation, and only presentation: §13.3 is explicit that momentum must
 * not multiply the winning side's troops, and this sets the fire for *both*
 * sides from one battle-wide number.
 */
export const FIRE_FLOOR = 0.35;

export function fireShare(intensity: number | undefined): number {
  if (intensity === undefined || !Number.isFinite(intensity)) {
    return FIRE_FLOOR;
  }
  const clamped = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
  return FIRE_FLOOR + (1 - FIRE_FLOOR) * clamped;
}

/**
 * How a tier of card support shows on a battlefield (§15, §40).
 *
 * As light standing along the two long edges of the contested ground — an
 * energy barrier, in §36.4's language — framing the whole arena rather than
 * either army. The tier is the battle's, both sides together, and says nothing
 * about which side the cards are behind; a curtain on one side only would be
 * inventing that.
 *
 * Four steps, each visibly more than the last, and never a count: *thousands of
 * deployed cards must not equal thousands of literal extra units* (§15).
 * `CALIBRATE` (§59.4).
 */
export interface SupportCurtain {
  /** How tall the curtain stands above the deck. */
  readonly height: number;
  /** How bright it is at its foot. */
  readonly opacity: number;
  /** How fast it breathes, in cycles per second. */
  readonly pulse: number;
}

const CURTAIN: Readonly<Record<CardSupportTier, SupportCurtain>> = {
  LOW: { height: 3, opacity: 0.14, pulse: 0.25 },
  MEDIUM: { height: 6, opacity: 0.22, pulse: 0.4 },
  HIGH: { height: 10, opacity: 0.32, pulse: 0.6 },
  MAX: { height: 16, opacity: 0.45, pulse: 0.9 },
};

/**
 * The tallest a curtain may stand.
 *
 * One of the two stands between the default camera and the field. Additive
 * light cannot hide the frontline — it only adds — but a tall bright sheet in
 * front of it still costs contrast, and §36.15 puts reading the frontline above
 * every effect. Kept to about the height of a trooper and a half.
 */
export const CURTAIN_MAX_HEIGHT = 16;

/** The curtain for a tier, or `null` before the first update says one. */
export function supportCurtain(tier: CardSupportTier | undefined): SupportCurtain | null {
  return tier === undefined ? null : CURTAIN[tier];
}

/**
 * How much smoke hangs over the frontline (§36.10, §13).
 *
 * Fire flared at the line and was gone, and between two armies drawn up 76
 * apart the contested ground read as an empty grid with a light on it. Smoke
 * hanging where the fire meets is what gives the middle of a battle a body —
 * and it hangs *on* the line, so it says where the frontline is rather than
 * hiding it (§36.15).
 *
 * As thick as the battle is hard: the same battle-wide intensity as the fire,
 * never below its floor while the battle is live, and none at all before it —
 * a pick phase has had no fighting to leave smoke. Only close enough to see:
 * at silhouette range an island is an outline (§37.6).
 */
const SMOKE_PUFFS: Readonly<Record<DetailLevel, number>> = {
  FULL: 44,
  REDUCED: 16,
  SILHOUETTE: 0,
  CULLED: 0,
};

/** The most puffs any battle draws, which is what the buffers are sized for. */
export const SMOKE_MAX_PUFFS = SMOKE_PUFFS.FULL;

export function smokePuffs(
  detail: DetailLevel,
  intensity: number | undefined,
  live: boolean,
): number {
  if (!live) {
    return 0;
  }
  return Math.round(SMOKE_PUFFS[detail] * fireShare(intensity));
}
