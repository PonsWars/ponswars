import { GOVERNED_TIERS, type QualityTier } from '@ponswars/world-runtime';

/**
 * The graphics tiers a player may choose between, and what they are called
 * (§82.2, §83.4).
 *
 * §82.2 leaves the override with the player: auto-detection *suggests* a tier,
 * and the world drops one when it cannot hold the frame budget, but neither
 * may decide for them. Until now there was nothing to decide with — the tier
 * was set in code and no surface offered it.
 *
 * Reduced Motion is deliberately not on this list. It is an accessibility
 * choice about movement, taken from the operating system's own setting
 * (§83.3), and offering it here as a picture-quality option would invite a
 * player to turn it off for frames.
 *
 * Words, not just a value: §83.4 keeps meaning off colour alone, and a tier is
 * a thing a player should be able to read.
 */
export const QUALITY_CHOICES: readonly QualityTier[] = GOVERNED_TIERS;

const LABELS: Readonly<Record<QualityTier, string>> = {
  ULTRA: 'Ultra',
  HIGH: 'High',
  BALANCED: 'Balanced',
  PERFORMANCE: 'Performance',
  REDUCED_MOTION: 'Reduced motion',
};

export function qualityLabel(tier: QualityTier): string {
  return LABELS[tier];
}

/** Whether a string from a form control is a tier this may be set to. */
export function isQualityChoice(value: string): value is QualityTier {
  return QUALITY_CHOICES.some((tier) => tier === value);
}
