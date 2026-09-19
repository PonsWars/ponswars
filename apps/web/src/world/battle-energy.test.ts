import { CARD_SUPPORT_TIERS } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { CURTAIN_MAX_HEIGHT, FIRE_FLOOR, fireShare, supportCurtain } from './battle-energy.js';

/**
 * What the engine's two presentation readings do to a battlefield (§13, §15).
 */

describe('how much fire is in the air', () => {
  it('rises with the intensity the engine reports', () => {
    expect(fireShare(0)).toBe(FIRE_FLOOR);
    expect(fireShare(0.5)).toBeGreaterThan(fireShare(0));
    expect(fireShare(1)).toBe(1);
  });

  it('never stops while a battle is live', () => {
    // A level battle is still a battle. Fire that stopped whenever nobody was
    // pushing would read as the fighting having stopped.
    expect(fireShare(0)).toBeGreaterThan(0);
  });

  it('holds the floor until the engine has said anything', () => {
    // Before the first update there is no reading, and the floor is not a
    // guess dressed as one.
    expect(fireShare(undefined)).toBe(FIRE_FLOOR);
    expect(fireShare(Number.NaN)).toBe(FIRE_FLOOR);
  });

  it('stays inside the rounds a detail level allows', () => {
    expect(fireShare(4)).toBe(1);
    expect(fireShare(-2)).toBe(FIRE_FLOOR);
  });
});

describe('how card support shows (§15, §40)', () => {
  it('grows visibly with every tier', () => {
    const curtains = CARD_SUPPORT_TIERS.map((tier) => supportCurtain(tier));
    for (let index = 1; index < curtains.length; index += 1) {
      expect(curtains[index]?.height).toBeGreaterThan(curtains[index - 1]?.height ?? Infinity);
      expect(curtains[index]?.opacity).toBeGreaterThan(curtains[index - 1]?.opacity ?? Infinity);
    }
  });

  it('shows nothing before the first update says a tier', () => {
    // An absent tier is not LOW. Drawing the lowest curtain for a battle the
    // client has heard nothing about would be claiming support it never saw.
    expect(supportCurtain(undefined)).toBeNull();
  });

  it('stays an accent, even at its strongest (§36.5)', () => {
    expect(supportCurtain('MAX')?.opacity).toBeLessThanOrEqual(0.6);
  });

  it('never stands tall enough to wall off the frontline (§36.15)', () => {
    for (const tier of CARD_SUPPORT_TIERS) {
      expect(supportCurtain(tier)?.height).toBeLessThanOrEqual(CURTAIN_MAX_HEIGHT);
    }
  });
});
