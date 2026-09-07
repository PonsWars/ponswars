import { BATTLE_SCORE_COMPONENTS, BATTLE_SCORE_WEIGHTS } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { POINT_SCALE, RATIO_SCALE, points } from './scale.js';
import {
  cardSupportStrength,
  FULL_SCORE_SCALED,
  NO_CARD_SUPPORT,
  ponsStrength,
  scoreBattle,
  splitByEdge,
  totalOf,
  volatilityAdjustedReturn,
  type AggregateCardSupport,
  type ScoringCalibration,
  type SideInputs,
} from './scoring.js';

/**
 * A calibration used only by these tests. Production values are CALIBRATE and
 * come from configuration — nothing here is a proposed production setting.
 */
const CAL: ScoringCalibration = {
  priceEdgeDivisor: 2n * RATIO_SCALE,
  volumeEdgeDivisor: 1n * RATIO_SCALE,
  ponsEdgeDivisor: 10n * RATIO_SCALE,
  cardEdgeDivisor: 10n * RATIO_SCALE,
};

const side = (overrides: Partial<SideInputs> = {}): SideInputs => ({
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 0n,
  uniqueActiveWallets: 0n,
  cardSupport: NO_CARD_SUPPORT,
  ...overrides,
});

const support = (overrides: Partial<AggregateCardSupport> = {}): AggregateCardSupport => ({
  ...NO_CARD_SUPPORT,
  ...overrides,
});

describe('splitByEdge', () => {
  it('splits evenly at a zero edge', () => {
    const split = splitByEdge(points(45), 0n);
    expect(split.left).toBe(points(45) / 2n);
    expect(split.right).toBe(points(45) / 2n);
  });

  it('gives the whole weight to the leading side at a saturated edge', () => {
    expect(splitByEdge(points(45), RATIO_SCALE)).toEqual({ left: points(45), right: 0n });
    expect(splitByEdge(points(45), -RATIO_SCALE)).toEqual({ left: 0n, right: points(45) });
  });

  it('clamps beyond saturation rather than overshooting', () => {
    // A component must never allocate more than its weight, whatever the input.
    expect(splitByEdge(points(45), 10n * RATIO_SCALE)).toEqual({ left: points(45), right: 0n });
    expect(splitByEdge(points(45), -10n * RATIO_SCALE)).toEqual({ left: 0n, right: points(45) });
  });

  it('always sums to exactly the component weight', () => {
    // §12: no component may steal weight from another. Computing the right
    // side as weight - left, rather than by a second division, is what makes
    // this exact for every input instead of nearly exact.
    for (const weight of [points(45), points(25), points(20), points(10)]) {
      for (let e = -1_200_000n; e <= 1_200_000n; e += 7_919n) {
        const split = splitByEdge(weight, e);
        expect(split.left + split.right).toBe(weight);
        expect(split.left).toBeGreaterThanOrEqual(0n);
        expect(split.right).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('is monotonic in the edge', () => {
    let previous = -1n;
    for (let e = -RATIO_SCALE; e <= RATIO_SCALE; e += 10_000n) {
      const { left } = splitByEdge(points(45), e);
      expect(left).toBeGreaterThanOrEqual(previous);
      previous = left;
    }
  });
});

describe('volatilityAdjustedReturn', () => {
  it('divides the window return by the asset’s own volatility', () => {
    // §12.1: a high-volatility asset must not gain a structural advantage
    // purely because it naturally moves more.
    const calm = side({ windowReturn: 10_000n, volatility: 10_000n });
    const wild = side({ windowReturn: 100_000n, volatility: 100_000n });
    expect(volatilityAdjustedReturn(calm)).toBe(volatilityAdjustedReturn(wild));
  });

  it('preserves sign for a falling market', () => {
    expect(volatilityAdjustedReturn(side({ windowReturn: -20_000n, volatility: 10_000n }))).toBe(
      -2n * RATIO_SCALE,
    );
  });

  it('rejects a non-positive volatility baseline', () => {
    expect(() => volatilityAdjustedReturn(side({ volatility: 0n }))).toThrow(RangeError);
    expect(() => volatilityAdjustedReturn(side({ volatility: -1n }))).toThrow(RangeError);
  });
});

describe('ponsStrength', () => {
  it('weights qualified activity 70 and unique wallets 30', () => {
    const activityOnly = ponsStrength(side({ qualifiedPonsActivity: 100n }));
    const walletsOnly = ponsStrength(side({ uniqueActiveWallets: 100n }));
    // sqrt(100) = 10 at scale; 70% vs 30% of the same magnitude.
    expect(activityOnly).toBe((10n * RATIO_SCALE * 70n) / 100n);
    expect(walletsOnly).toBe((10n * RATIO_SCALE * 30n) / 100n);
  });

  it('diminishes so one whale cannot linearly dominate', () => {
    // §12.3. A hundred times the activity is ten times the strength, not a
    // hundred - which is the whole point of the normalization.
    const small = ponsStrength(side({ qualifiedPonsActivity: 100n }));
    const large = ponsStrength(side({ qualifiedPonsActivity: 10_000n }));
    expect(large).toBe(small * 10n);
  });

  it('is zero with no activity', () => {
    expect(ponsStrength(side())).toBe(0n);
  });

  it('rejects negative counts', () => {
    expect(() => ponsStrength(side({ qualifiedPonsActivity: -1n }))).toThrow(RangeError);
    expect(() => ponsStrength(side({ uniqueActiveWallets: -1n }))).toThrow(RangeError);
  });
});

describe('cardSupportStrength', () => {
  it('is zero with no cards deployed', () => {
    expect(cardSupportStrength(NO_CARD_SUPPORT)).toBe(0n);
  });

  it('applies diminishing returns', () => {
    // §12.4: four times the raw support must not produce four times the
    // influence. Under a square root it produces twice.
    //
    // Compared within one scaled unit rather than exactly: both values are
    // floored independently, and sqrt(50) and sqrt(200) are irrational, so
    // 2 x floor(a) can sit one unit below floor(2a). Demanding exact equality
    // would be asserting something the arithmetic does not promise.
    const single = cardSupportStrength(support({ market: 100n }));
    const quadruple = cardSupportStrength(support({ market: 400n }));
    const drift = quadruple - single * 2n;
    expect(drift >= -1n && drift <= 1n).toBe(true);

    // The property that actually matters: nothing close to four times.
    expect(quadruple).toBeLessThan(single * 3n);
  });

  it('spreads general support across the three scoring channels', () => {
    // §12.4: General is distributed proportionally following the base battle
    // weighting, so it is worth the same as an equal charge aimed anywhere.
    const general = cardSupportStrength(support({ general: 900n }));
    const spread = cardSupportStrength(
      support({
        market: (900n * BigInt(BATTLE_SCORE_WEIGHTS.priceMomentum)) / 90n,
        volume: (900n * BigInt(BATTLE_SCORE_WEIGHTS.relativeVolume)) / 90n,
        pons: (900n * BigInt(BATTLE_SCORE_WEIGHTS.ponsPower)) / 90n,
      }),
    );
    expect(general).toBe(spread);
  });

  it('emphasises channels by the base battle weighting', () => {
    // A market charge is worth more than a Pons charge because price momentum
    // carries 45 points and Pons power carries 20.
    expect(cardSupportStrength(support({ market: 100n }))).toBeGreaterThan(
      cardSupportStrength(support({ pons: 100n })),
    );
  });

  it('rejects negative support', () => {
    expect(() => cardSupportStrength(support({ market: -1n }))).toThrow(RangeError);
  });
});

describe('scoreBattle', () => {
  it('splits every component evenly when both sides are identical', () => {
    const score = scoreBattle(side(), side(), CAL);
    for (const component of BATTLE_SCORE_COMPONENTS) {
      expect(score.left[component]).toBe(score.right[component]);
    }
    expect(score.leftTotal).toBe(score.rightTotal);
    expect(score.leftTotal).toBe(FULL_SCORE_SCALED / 2n);
  });

  it('always totals exactly one hundred points', () => {
    // The invariant §12 rests on. Checked across a wide input sweep rather
    // than a few hand-picked cases.
    const samples: [SideInputs, SideInputs][] = [
      [side(), side()],
      [side({ windowReturn: 50_000n }), side({ windowReturn: -50_000n })],
      [side({ relativeVolume: 3n * RATIO_SCALE }), side({ relativeVolume: 0n })],
      [side({ qualifiedPonsActivity: 9_999n }), side({ uniqueActiveWallets: 7n })],
      [side({ cardSupport: support({ general: 12_345n }) }), side()],
      [
        side({ windowReturn: -1n, volatility: 1n, relativeVolume: 1n }),
        side({ windowReturn: 999_999n, volatility: 3n, relativeVolume: 999_999n }),
      ],
    ];
    for (const [left, right] of samples) {
      const score = scoreBattle(left, right, CAL);
      expect(score.leftTotal + score.rightTotal).toBe(FULL_SCORE_SCALED);
      expect(totalOf(score.left) + totalOf(score.right)).toBe(FULL_SCORE_SCALED);
    }
  });

  it('caps each component at its declared weight', () => {
    const dominant = side({
      windowReturn: 10n * RATIO_SCALE,
      relativeVolume: 100n * RATIO_SCALE,
      qualifiedPonsActivity: 1_000_000n,
      uniqueActiveWallets: 1_000_000n,
      cardSupport: support({ general: 1_000_000n }),
    });
    const score = scoreBattle(dominant, side(), CAL);
    for (const component of BATTLE_SCORE_COMPONENTS) {
      expect(score.left[component]).toBe(points(BATTLE_SCORE_WEIGHTS[component]));
      expect(score.right[component]).toBe(0n);
    }
    expect(score.leftTotal).toBe(FULL_SCORE_SCALED);
  });

  it('lets a relatively stronger side win while both are falling', () => {
    // §12.1: both assets can be negative, and the less-negative normalized
    // performance still wins the component.
    const lessBad = side({ windowReturn: -10_000n, volatility: RATIO_SCALE });
    const worse = side({ windowReturn: -50_000n, volatility: RATIO_SCALE });
    const score = scoreBattle(lessBad, worse, CAL);
    expect(score.left.priceMomentum).toBeGreaterThan(score.right.priceMomentum);
  });

  it('never lets card support alone overturn a clear market lead', () => {
    // §12.4: cards may tilt close wars but cannot overpower real market
    // behaviour. Even at maximum card support, 10 points cannot beat a side
    // holding all 45 price and all 25 volume points.
    const marketLeader = side({
      windowReturn: 10n * RATIO_SCALE,
      relativeVolume: 100n * RATIO_SCALE,
    });
    const cardStacked = side({ cardSupport: support({ general: 100_000_000n }) });
    const score = scoreBattle(marketLeader, cardStacked, CAL);

    expect(score.right.holderCardSupport).toBe(points(10));
    expect(score.leftTotal).toBeGreaterThan(score.rightTotal);
  });

  it('is unaffected by cards when both sides deploy equally', () => {
    const both = support({ general: 5_000n });
    const score = scoreBattle(side({ cardSupport: both }), side({ cardSupport: both }), CAL);
    expect(score.left.holderCardSupport).toBe(score.right.holderCardSupport);
  });

  it('treats no signal as a tie rather than favouring a side', () => {
    // Zero Pons activity on both sides is an absence of evidence, not a win
    // for whichever side the arithmetic happens to reach first.
    const score = scoreBattle(side(), side(), CAL);
    expect(score.edges.ponsPower).toBe(0n);
    expect(score.left.ponsPower).toBe(score.right.ponsPower);
  });

  it('is symmetric: swapping sides mirrors the result', () => {
    const a = side({ windowReturn: 40_000n, qualifiedPonsActivity: 500n });
    const b = side({ relativeVolume: 2n * RATIO_SCALE, cardSupport: support({ market: 300n }) });
    const forward = scoreBattle(a, b, CAL);
    const reversed = scoreBattle(b, a, CAL);

    expect(reversed.leftTotal).toBe(forward.rightTotal);
    expect(reversed.rightTotal).toBe(forward.leftTotal);
    for (const component of BATTLE_SCORE_COMPONENTS) {
      expect(reversed.left[component]).toBe(forward.right[component]);
    }
  });

  it('is deterministic across repeated evaluation', () => {
    const a = side({ windowReturn: 12_345n, qualifiedPonsActivity: 777n });
    const b = side({ relativeVolume: 1_234_567n });
    expect(scoreBattle(a, b, CAL)).toEqual(scoreBattle(a, b, CAL));
  });

  it('retains the edges as audit evidence', () => {
    // §26: the system must answer "why did this stock win this round?" from
    // recorded evidence. The edges are the intermediate step that explains the
    // split, so they travel with the result rather than being recomputed.
    const score = scoreBattle(side({ windowReturn: 40_000n }), side(), CAL);
    expect(Object.keys(score.edges).sort()).toEqual([...BATTLE_SCORE_COMPONENTS].sort());
    expect(score.edges.priceMomentum).toBeGreaterThan(0n);
  });

  it('rejects a non-positive calibration divisor', () => {
    expect(() =>
      scoreBattle(side({ windowReturn: 1n }), side(), { ...CAL, priceEdgeDivisor: 0n }),
    ).toThrow(RangeError);
  });

  it('scales points so a component is divisible without drift', () => {
    expect(POINT_SCALE).toBe(1_000_000n);
    expect(points(45)).toBe(45_000_000n);
    expect(FULL_SCORE_SCALED).toBe(100_000_000n);
  });
});
