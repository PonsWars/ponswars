import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_INPUT_WEIGHTS,
  CONFIDENCE_INPUTS,
  CONFIDENCE_IS_PROBABILITY,
  CONFIDENCE_LABELS,
  CONFIDENCE_LOOKBACK,
  isUnderdogLabel,
  UNDERDOG_LABELS,
} from './confidence.js';
import { BASIS_POINTS_DENOMINATOR, baseUnits, mulDivFloor } from './money.js';
import {
  baseWpAwardReason,
  canTransitionDistribution,
  DISTRIBUTION_STATES,
  DISTRIBUTION_TRANSITIONS,
  DISTRIBUTION_WINDOW,
  isUpset,
  MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL,
  MIN_QUALIFYING_WP,
  PER_WALLET_CAP_BPS,
  POOL_CARRYOVER_BPS,
  POOL_DISTRIBUTABLE_BPS,
  qualifiesForDistribution,
  REWARD_WEIGHT_SCALE,
  rewardWeight,
  upsetLabelFor,
  winningPickWp,
  WP_AWARD_REASONS,
  WP_AWARDS,
} from './rewards.js';

describe('battle confidence', () => {
  it('is never a probability', () => {
    // §10 and Guide §7.1: no "67% chance to win" anywhere, ever. A delivered
    // PNG shows one, which is why this is a constant rather than a convention.
    expect(CONFIDENCE_IS_PROBABILITY).toBe(false);
  });

  it('weights inputs 40/25/20/15 summing to 100', () => {
    expect(CONFIDENCE_INPUT_WEIGHTS).toEqual({
      recentPriceTrend: 40,
      relativeVolumePulse: 25,
      ponsActivity: 20,
      recentMomentumStability: 15,
    });
    const sum = CONFIDENCE_INPUTS.reduce((t, input) => t + CONFIDENCE_INPUT_WEIGHTS[input], 0);
    expect(sum).toBe(100);
  });

  it('samples the fifteen minutes before pick phase', () => {
    expect(CONFIDENCE_LOOKBACK).toBe(900_000);
  });

  it('declares the six labels ordered weakest to strongest', () => {
    expect([...CONFIDENCE_LABELS]).toEqual([
      'HEAVY_UNDERDOG',
      'UNDERDOG',
      'EVEN',
      'FAVORED',
      'STRONG_FAVORITE',
      'DOMINANT',
    ]);
  });

  it('treats exactly two labels as underdog', () => {
    expect([...UNDERDOG_LABELS]).toEqual(['UNDERDOG', 'HEAVY_UNDERDOG']);
    for (const label of CONFIDENCE_LABELS) {
      expect(isUnderdogLabel(label)).toBe(label === 'UNDERDOG' || label === 'HEAVY_UNDERDOG');
    }
  });
});

describe('war point awards', () => {
  it('matches the locked values', () => {
    expect(WP_AWARDS).toEqual({
      WIN: 10,
      UNDERDOG_WIN: 12,
      HEAVY_UNDERDOG_WIN: 14,
      CARD_ASSIST: 2,
    });
  });

  it('declares an award for every reason', () => {
    expect(Object.keys(WP_AWARDS).sort()).toEqual([...WP_AWARD_REASONS].sort());
  });

  it('pays more for a bigger upset', () => {
    expect(WP_AWARDS.WIN).toBeLessThan(WP_AWARDS.UNDERDOG_WIN);
    expect(WP_AWARDS.UNDERDOG_WIN).toBeLessThan(WP_AWARDS.HEAVY_UNDERDOG_WIN);
  });

  it.each([
    ['DOMINANT', 'WIN'],
    ['STRONG_FAVORITE', 'WIN'],
    ['FAVORED', 'WIN'],
    ['EVEN', 'WIN'],
    ['UNDERDOG', 'UNDERDOG_WIN'],
    ['HEAVY_UNDERDOG', 'HEAVY_UNDERDOG_WIN'],
  ] as const)('a %s winner earns %s', (confidence, reason) => {
    expect(baseWpAwardReason(confidence)).toBe(reason);
  });

  it.each([
    ['EVEN', false, 10],
    ['EVEN', true, 12],
    ['UNDERDOG', false, 12],
    ['UNDERDOG', true, 14],
    ['HEAVY_UNDERDOG', false, 14],
    ['HEAVY_UNDERDOG', true, 16],
  ] as const)('a %s winner with card=%s earns %i WP', (confidence, card, expected) => {
    expect(winningPickWp(confidence, card)).toBe(expected);
  });

  it('adds card assist on top of the base award, never instead of it', () => {
    for (const label of CONFIDENCE_LABELS) {
      expect(winningPickWp(label, true) - winningPickWp(label, false)).toBe(WP_AWARDS.CARD_ASSIST);
    }
  });

  it('labels upsets and leaves everything else unlabelled', () => {
    expect(upsetLabelFor('HEAVY_UNDERDOG')).toBe('MAJOR_UPSET');
    expect(upsetLabelFor('UNDERDOG')).toBe('UPSET_VICTORY');
    expect(upsetLabelFor('EVEN')).toBeNull();
    expect(upsetLabelFor('DOMINANT')).toBeNull();
    for (const label of CONFIDENCE_LABELS) {
      expect(isUpset(label)).toBe(upsetLabelFor(label) !== null);
    }
  });
});

describe('distribution parameters', () => {
  it('runs on a 24-hour window', () => {
    expect(DISTRIBUTION_WINDOW).toBe(86_400_000);
  });

  it('qualifies at fifty window war points', () => {
    expect(MIN_QUALIFYING_WP).toBe(50);
    expect(qualifiesForDistribution(49)).toBe(false);
    expect(qualifiesForDistribution(50)).toBe(true);
    expect(qualifiesForDistribution(51)).toBe(true);
    expect(qualifiesForDistribution(0)).toBe(false);
  });

  it('splits the pool 80/20', () => {
    expect(POOL_DISTRIBUTABLE_BPS).toBe(8_000);
    expect(POOL_CARRYOVER_BPS).toBe(2_000);
    expect(BigInt(POOL_DISTRIBUTABLE_BPS) + BigInt(POOL_CARRYOVER_BPS)).toBe(
      BASIS_POINTS_DENOMINATOR,
    );
  });

  it('caps a wallet at two percent of the pool', () => {
    expect(PER_WALLET_CAP_BPS).toBe(200);
  });

  it('keeps the per-wallet cap well below the distributable share', () => {
    // A cap at or above the distributable share would let one wallet take the
    // whole window, which is the outcome §16.6 exists to prevent.
    expect(PER_WALLET_CAP_BPS).toBeLessThan(POOL_DISTRIBUTABLE_BPS);
  });

  it('names the claim threshold as a baseline, not a locked value', () => {
    // §16.7 gives 0.001 SPY as an example still to be confirmed. The name
    // carries that status so nobody treats it as settled policy.
    expect(MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL).toBe('0.001');
  });
});

describe('reward weight', () => {
  it('is the scaled square root of war points', () => {
    expect(rewardWeight(0)).toBe(0n);
    expect(rewardWeight(1)).toBe(REWARD_WEIGHT_SCALE);
    expect(rewardWeight(4)).toBe(2n * REWARD_WEIGHT_SCALE);
    expect(rewardWeight(100)).toBe(10n * REWARD_WEIGHT_SCALE);
    expect(rewardWeight(10_000)).toBe(100n * REWARD_WEIGHT_SCALE);
  });

  it('diminishes: ten times the points is about three times the weight', () => {
    // §16.5. This is the whole point of sqrt weighting - it compresses the gap
    // between a heavy grinder and a casual qualifier.
    const low = rewardWeight(50);
    const high = rewardWeight(500);
    const ratio = Number(high) / Number(low);
    expect(ratio).toBeGreaterThan(3.1);
    expect(ratio).toBeLessThan(3.2);
  });

  it('is monotonic in war points', () => {
    let previous = -1n;
    for (const wp of [0, 1, 2, 50, 51, 100, 999, 1_000, 100_000]) {
      const weight = rewardWeight(wp);
      expect(weight).toBeGreaterThan(previous);
      previous = weight;
    }
  });

  it('is exact for non-square war point totals', () => {
    // sqrt(50) is irrational. The scaled integer is deterministic where a
    // double would leave the last bits to the engine.
    const weight = rewardWeight(50);
    expect(weight).toBe(7_071_067_811n);
    expect(weight * weight).toBeLessThanOrEqual(50n * REWARD_WEIGHT_SCALE * REWARD_WEIGHT_SCALE);
    expect((weight + 1n) * (weight + 1n)).toBeGreaterThan(
      50n * REWARD_WEIGHT_SCALE * REWARD_WEIGHT_SCALE,
    );
  });

  it('is deterministic across repeated evaluation', () => {
    for (const wp of [50, 137, 9_999]) {
      expect(rewardWeight(wp)).toBe(rewardWeight(wp));
    }
  });

  it.each([-1, 1.5, Number.NaN])('rejects invalid war points: %s', (wp) => {
    expect(() => rewardWeight(wp)).toThrow(RangeError);
  });

  it('allocates a pool proportionally without exceeding it', () => {
    // The shape the Rewards Engine will use: weight / totalWeight * pool, all
    // in exact bigint, floored so the sum can never overshoot the pool.
    const pool = baseUnits(1_000_000_000n);
    const wallets = [50, 200, 450, 800];
    const weights = wallets.map(rewardWeight);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0n);
    const allocations = weights.map((w) => mulDivFloor(pool, w, totalWeight));
    const allocated = allocations.reduce((sum, a) => sum + a, 0n);

    expect(allocated).toBeLessThanOrEqual(pool);
    // Flooring loses at most one base unit per wallet; the remainder carries
    // forward rather than vanishing (§16.7).
    expect(pool - allocated).toBeLessThanOrEqual(BigInt(wallets.length));
    for (const allocation of allocations) {
      expect(allocation).toBeGreaterThan(0n);
    }
  });
});

describe('distribution lifecycle', () => {
  it('declares a transition list for every state', () => {
    expect(Object.keys(DISTRIBUTION_TRANSITIONS).sort()).toEqual([...DISTRIBUTION_STATES].sort());
  });

  it('runs open to snapshot to calculated to published to closed', () => {
    expect(canTransitionDistribution('OPEN', 'SNAPSHOT')).toBe(true);
    expect(canTransitionDistribution('SNAPSHOT', 'CALCULATED')).toBe(true);
    expect(canTransitionDistribution('CALCULATED', 'PUBLISHED')).toBe(true);
    expect(canTransitionDistribution('PUBLISHED', 'CLOSED')).toBe(true);
  });

  it('never moves backwards once a root is published', () => {
    // §17: published distribution roots are immutable and admin may not edit
    // individual rewards after finalization.
    expect(canTransitionDistribution('PUBLISHED', 'CALCULATED')).toBe(false);
    expect(canTransitionDistribution('CLOSED', 'PUBLISHED')).toBe(false);
    expect(DISTRIBUTION_TRANSITIONS.CLOSED).toHaveLength(0);
  });

  it('never skips calculation before publishing', () => {
    expect(canTransitionDistribution('SNAPSHOT', 'PUBLISHED')).toBe(false);
    expect(canTransitionDistribution('OPEN', 'PUBLISHED')).toBe(false);
  });
});
