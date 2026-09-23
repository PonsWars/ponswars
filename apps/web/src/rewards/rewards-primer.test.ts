import {
  MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL,
  MIN_QUALIFYING_WP,
  PER_WALLET_CAP_BPS,
  POOL_CARRYOVER_BPS,
  POOL_DISTRIBUTABLE_BPS,
  WP_AWARDS,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { distributionRules, earningRules } from './rewards-primer.js';

/**
 * What the Rewards page tells a visitor about the arithmetic (§11, §16, §102).
 */

describe('what earns War Points', () => {
  it('takes every figure from the locked awards, never its own', () => {
    const points = earningRules().map((rule) => rule.points);

    expect(points).toEqual([
      WP_AWARDS.WIN,
      WP_AWARDS.UNDERDOG_WIN,
      WP_AWARDS.HEAVY_UNDERDOG_WIN,
      WP_AWARDS.CARD_ASSIST,
    ]);
  });

  it('is ordered so a bigger upset reads as worth more', () => {
    const [win, underdog, heavy] = earningRules();

    expect(win?.points).toBeLessThan(underdog?.points ?? 0);
    expect(underdog?.points).toBeLessThan(heavy?.points ?? 0);
  });
});

describe('how a window pays', () => {
  const said = (): string =>
    distributionRules()
      .map((rule) => `${rule.title} ${rule.detail}`)
      .join(' ');

  it('states the window, the qualifying points, both pool shares and the cap', () => {
    const text = said();

    expect(text).toContain('24 HOURS');
    expect(text).toContain(String(MIN_QUALIFYING_WP));
    expect(text).toContain(`${String(POOL_DISTRIBUTABLE_BPS / 100)}% PAID`);
    expect(text).toContain(`${String(POOL_CARRYOVER_BPS / 100)}% CARRIED`);
    expect(text).toContain(`${String(PER_WALLET_CAP_BPS / 100)}% CAP`);
  });

  it('says the weighting is the square root, which is what decides a share (§16.5)', () => {
    expect(said().toLowerCase()).toContain('square root');
  });

  it('promises no amount, and states no value the registry leaves open (§30, §102)', () => {
    const text = said();

    // §16.7 leaves the claim threshold BASELINE: printing it here would make a
    // page into policy.
    expect(text).not.toContain(MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL);
    expect(text).not.toMatch(/SPY\s*\d|\$\d|\d+\s*SPY/);
  });
});
