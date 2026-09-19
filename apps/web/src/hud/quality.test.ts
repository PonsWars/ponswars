import { QUALITY_TIERS } from '@ponswars/world-runtime';
import { describe, expect, it } from 'vitest';
import { isQualityChoice, QUALITY_CHOICES, qualityLabel } from './quality.js';

/**
 * What a player may choose their graphics to be (§82.2, §83.3).
 */

describe('the graphics choices', () => {
  it('names every tier in words (§83.4)', () => {
    for (const tier of QUALITY_TIERS) {
      expect(qualityLabel(tier)).toMatch(/^[A-Z]/);
    }
  });

  it('runs best to lightest, so the list reads as a scale', () => {
    expect(QUALITY_CHOICES).toEqual(['ULTRA', 'HIGH', 'BALANCED', 'PERFORMANCE']);
  });

  it('never offers reduced motion as a picture setting (§83.3)', () => {
    // It is an accessibility choice about movement, taken from the operating
    // system. Offering it here would invite turning it off for frames.
    expect(QUALITY_CHOICES).not.toContain('REDUCED_MOTION');
    expect(isQualityChoice('REDUCED_MOTION')).toBe(false);
  });

  it('refuses anything that is not a tier', () => {
    expect(isQualityChoice('ultra')).toBe(false);
    expect(isQualityChoice('')).toBe(false);
    expect(isQualityChoice('BALANCED')).toBe(true);
  });
});
