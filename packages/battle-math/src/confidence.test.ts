import { CONFIDENCE_LABELS, type ConfidenceSnapshot } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  assertCalibration,
  directionChanges,
  matchupConfidence,
  MAX_CONFIDENCE_STANDING,
  subSignals,
  type ConfidenceCalibration,
  type ConfidenceLookback,
} from './confidence.js';
import { RATIO_SCALE } from './scale.js';

/**
 * Battle Confidence (§10).
 *
 * The rules under test are the ones §10 states and the ones it forbids: no
 * percentage anywhere, a label that agrees with the sub-signals beside it, and
 * nothing about card support.
 */

const CALIBRATION: ConfidenceCalibration = {
  // Half a standard deviation is a strong trend; half a deviation down is a
  // weak one. Test values, not a recommendation — §102 keeps these open.
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: (RATIO_SCALE * 13n) / 10n, weak: (RATIO_SCALE * 7n) / 10n },
  ponsActivity: { high: 40n, medium: 15n },
  momentumStability: { stable: 2, mixed: 5 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

/** A side with every band in the middle, so a test can move one at a time. */
const NEUTRAL: ConfidenceLookback = {
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 20n,
  subWindowReturns: [10n, 10n, 10n],
};

/** Every band at its top: strong trend, rising volume, high activity, stable. */
const STRONGEST: ConfidenceLookback = {
  windowReturn: RATIO_SCALE,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE * 2n,
  qualifiedPonsActivity: 100n,
  subWindowReturns: [10n, 20n, 30n],
};

/** Every band at its bottom. */
const WEAKEST: ConfidenceLookback = {
  windowReturn: -RATIO_SCALE,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE / 2n,
  qualifiedPonsActivity: 1n,
  subWindowReturns: [10n, -10n, 10n, -10n, 10n, -10n, 10n],
};

/** The four ranks a band combination sits at, in §10.1 order. */
type Ranks = readonly [number, number, number, number];

/**
 * One lookback for every combination of bands — 3⁴ of them.
 *
 * Each field is chosen to land squarely inside its band rather than on its
 * edge, so the enumeration tests the label rule and not the banding.
 */
function bandCombinations(): readonly {
  readonly ranks: Ranks;
  readonly lookback: ConfidenceLookback;
}[] {
  const trend = [-RATIO_SCALE, 0n, RATIO_SCALE];
  const volume = [RATIO_SCALE / 2n, RATIO_SCALE, RATIO_SCALE * 2n];
  const pons = [1n, 20n, 100n];
  // 6, 3 and 0 direction changes: UNSTABLE, MIXED and STABLE.
  const paths = [
    [10n, -10n, 10n, -10n, 10n, -10n, 10n],
    [10n, -10n, 10n, -10n],
    [10n, 20n, 30n],
  ];

  const all: { ranks: Ranks; lookback: ConfidenceLookback }[] = [];
  for (let priceTrend = 0; priceTrend < 3; priceTrend += 1) {
    for (let volumePulse = 0; volumePulse < 3; volumePulse += 1) {
      for (let ponsActivity = 0; ponsActivity < 3; ponsActivity += 1) {
        for (let stability = 0; stability < 3; stability += 1) {
          all.push({
            ranks: [priceTrend, volumePulse, ponsActivity, stability],
            lookback: {
              windowReturn: trend[priceTrend] ?? 0n,
              volatility: RATIO_SCALE,
              relativeVolume: volume[volumePulse] ?? RATIO_SCALE,
              qualifiedPonsActivity: pons[ponsActivity] ?? 0n,
              subWindowReturns: paths[stability] ?? [],
            },
          });
        }
      }
    }
  }
  return all;
}

/** Whether one side is at least as strong as the other in all four bands. */
function leadsEverywhere(stronger: Ranks, weaker: Ranks): boolean {
  return stronger.every((rank, index) => rank >= (weaker[index] ?? 0));
}

/**
 * The working calibration with one part replaced, ready to be thrown at.
 *
 * Every rejection below overrides a single field, so the surrounding valid
 * settings are the same in each case and the assertion is about the one thing
 * that changed.
 */
function checking(override: Partial<ConfidenceCalibration>): () => void {
  return () => {
    assertCalibration({ ...CALIBRATION, ...override });
  };
}

describe('sub-signals', () => {
  it('reads every band at its top', () => {
    expect(subSignals(STRONGEST, CALIBRATION)).toEqual({
      priceTrend: 'STRONG',
      volumePulse: 'RISING',
      ponsActivity: 'HIGH',
      momentumStability: 'STABLE',
    });
  });

  it('reads every band at its bottom', () => {
    expect(subSignals(WEAKEST, CALIBRATION)).toEqual({
      priceTrend: 'WEAK',
      volumePulse: 'WEAK',
      ponsActivity: 'LOW',
      momentumStability: 'UNSTABLE',
    });
  });

  it('judges price trend after dividing by the ticker own volatility', () => {
    // §12.1 divides by volatility so a naturally jumpy stock gains no
    // structural edge, and §10.1 screens the same input. The same raw return
    // reads differently depending on what is normal for that asset.
    const jumpy = { ...NEUTRAL, windowReturn: RATIO_SCALE, volatility: RATIO_SCALE * 4n };
    const calm = { ...NEUTRAL, windowReturn: RATIO_SCALE, volatility: RATIO_SCALE };

    expect(subSignals(jumpy, CALIBRATION).priceTrend).toBe('MIXED');
    expect(subSignals(calm, CALIBRATION).priceTrend).toBe('STRONG');
  });

  it('refuses a volatility of zero rather than dividing by it', () => {
    expect(() => subSignals({ ...NEUTRAL, volatility: 0n }, CALIBRATION)).toThrow(RangeError);
  });
});

describe('momentum stability', () => {
  it('counts reversals, not movement', () => {
    // A window that climbed the whole way and one that ended where it started
    // are both steady; §10.1 separates them from one that thrashed.
    expect(directionChanges([1n, 2n, 3n, 4n])).toBe(0);
    expect(directionChanges([1n, -1n, 1n, -1n])).toBe(3);
  });

  it('treats a flat interval as part of the move around it', () => {
    // A quiet minute inside a climb is not a reversal, and clearing the running
    // direction on it would make a calm market read as an unstable one.
    expect(directionChanges([1n, 0n, 1n])).toBe(0);
    expect(directionChanges([1n, 0n, -1n])).toBe(1);
  });

  it('reads an empty path as stable rather than throwing', () => {
    // A window with no sub-intervals has nothing to reverse. Stability is the
    // absence of reversals, so absence of data is the same answer.
    expect(directionChanges([])).toBe(0);
  });
});

describe('the matchup label', () => {
  it('calls two identical sides even', () => {
    const { left, right } = matchupConfidence(NEUTRAL, NEUTRAL, CALIBRATION);
    expect([left.label, right.label]).toEqual(['EVEN', 'EVEN']);
  });

  it('pairs a dominant side with a heavy underdog', () => {
    // §11 pays the upset award off the loser expectation, so the two labels
    // have to be produced together and agree.
    const { left, right } = matchupConfidence(STRONGEST, WEAKEST, CALIBRATION);
    expect([left.label, right.label]).toEqual(['DOMINANT', 'HEAVY_UNDERDOG']);
  });

  it('is symmetric when the sides are swapped', () => {
    const forward = matchupConfidence(STRONGEST, WEAKEST, CALIBRATION);
    const reversed = matchupConfidence(WEAKEST, STRONGEST, CALIBRATION);

    expect(reversed.left.label).toBe(forward.right.label);
    expect(reversed.right.label).toBe(forward.left.label);
  });

  it('never gives the weaker label to a side that leads in every band', () => {
    // The property the whole design exists for, checked over every pair of band
    // combinations there is — 81 against 81.
    //
    // Note what is *not* asserted: that more strong bands means a better label.
    // That is false, and deliberately so. §10.1 weights price trend at 40 and
    // stability at 15, so a side can lead on the count of bands and still be
    // the underdog. What must hold is monotonicity — leading or tying in all
    // four cannot earn the weaker word, because the standing is a weighted sum
    // with positive weights over exactly those four ranks.
    const standingOrder = (label: ConfidenceSnapshot['label']): number =>
      CONFIDENCE_LABELS.indexOf(label);

    const combinations = bandCombinations();
    let dominatingPairs = 0;

    for (const stronger of combinations) {
      for (const weaker of combinations) {
        if (!leadsEverywhere(stronger.ranks, weaker.ranks)) {
          continue;
        }
        dominatingPairs += 1;
        const { left, right } = matchupConfidence(stronger.lookback, weaker.lookback, CALIBRATION);
        expect(standingOrder(left.label)).toBeGreaterThanOrEqual(standingOrder(right.label));
      }
    }

    // Guards the loop itself: a filter that matched nothing would make the
    // assertions above vacuous and the test green for the wrong reason.
    expect(dominatingPairs).toBe(1_296);
  });

  it('carries no number a client could read as a probability', () => {
    // §10 forbids showing an exact percentage, and Guide §7.1 lists one as a
    // mockup error. The snapshot has room for a label and four words, and this
    // asserts it stays that way.
    const { left } = matchupConfidence(STRONGEST, WEAKEST, CALIBRATION);
    expect(Object.keys(left).sort()).toEqual([
      'label',
      'momentumStability',
      'ponsActivity',
      'priceTrend',
      'volumePulse',
    ]);
    for (const value of Object.values(left)) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('the calibration', () => {
  it('is an input rather than a default', () => {
    // §102: nothing in this module supplies these numbers. The check is that
    // the exported surface offers no calibration to fall back on, so a caller
    // has to decide — which is the whole point of an OPEN parameter.
    expect(matchupConfidence.length).toBe(3);
  });

  it('rejects bands that are the wrong way round', () => {
    expect(checking({ priceTrend: { strong: -RATIO_SCALE, weak: RATIO_SCALE } })).toThrow(
      /weak < strong/,
    );
    expect(checking({ volumePulse: { rising: 0n, weak: RATIO_SCALE } })).toThrow(/weak < rising/);
    expect(checking({ ponsActivity: { high: 1n, medium: 9n } })).toThrow(/medium <= high/);
  });

  it('rejects stability bands that are not whole counts', () => {
    expect(checking({ momentumStability: { stable: 1.5, mixed: 4 } })).toThrow(/whole counts/);
    expect(checking({ momentumStability: { stable: 4, mixed: 1 } })).toThrow(/whole counts/);
  });

  it('rejects matchup gaps that are not ordered', () => {
    expect(checking({ matchup: { favored: 0, strongFavorite: 60, dominant: 120 } })).toThrow(
      /favored < strongFavorite/,
    );
  });

  it('rejects a dominant gap no matchup could ever reach', () => {
    // A gap above the largest possible standing difference would make
    // DOMINANT unreachable, and the setting would look like a market that
    // never produces a favourite rather than like a mistake.
    expect(
      checking({
        matchup: { favored: 20, strongFavorite: 60, dominant: MAX_CONFIDENCE_STANDING + 1 },
      }),
    ).toThrow(/unreachable/);
  });

  it('bounds the standing at the weights §10.1 names', () => {
    // 40 + 25 + 20 + 15 = 100, doubled by the three-band ranking.
    expect(MAX_CONFIDENCE_STANDING).toBe(200);
  });
});
