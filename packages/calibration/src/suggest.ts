import { RATIO_SCALE } from '@ponswars/battle-math';
import type { CalibrationReport } from './calibrate.js';
import type { Distribution } from './distribution.js';

/**
 * Starting values read off a report, and the rule each was read by.
 *
 * Only for the quantities whose meaning is a place in a distribution: where a
 * component saturates, where a margin stops being narrow, where a confidence
 * band starts. The market's own bounds — divergence, staleness, dust — are not
 * here. Those trade voided battles against battles decided on thin data, which
 * is a product decision (§102); the report shows the void rates each set of
 * bounds produces, and a person picks.
 *
 * The rules are deliberately plain so a reviewer can argue with them:
 *
 * - a component saturates at the 90th-percentile gap between two sides, so an
 *   ordinary difference moves the score and only an extreme one maxes it;
 * - a margin is narrow below the 25th percentile and decisive above the 75th;
 * - momentum pushes, surges and dominates at the 50th, 75th and 90th
 *   percentile of how far from even a battle sits, and a comeback must have
 *   trailed by the 75th;
 * - each three-band confidence signal puts its middle half in the middle band,
 *   read per ticker and then taken at the median ticker.
 */

export interface Suggestion {
  readonly engine: {
    readonly scoring: {
      readonly priceEdgeDivisor: string;
      readonly volumeEdgeDivisor: string;
      readonly ponsEdgeDivisor: string;
    };
    readonly momentum: {
      readonly push: string;
      readonly surge: string;
      readonly dominance: string;
      readonly comeback: string;
    };
    readonly victory: { readonly narrowMargin: string; readonly decisiveMargin: string };
  };
  readonly confidence: {
    readonly priceTrend: { readonly strong: string; readonly weak: string };
    readonly volumePulse: { readonly rising: string; readonly weak: string };
    readonly ponsActivity: { readonly high: string; readonly medium: string };
    readonly momentumStability: { readonly stable: number; readonly mixed: number };
  };
  /** What the suggestion could not be read from, and so left out. */
  readonly missing: readonly string[];
}

export function suggest(report: CalibrationReport): Suggestion {
  const missing: string[] = [];
  const at = (distribution: Distribution, key: keyof Distribution, name: string): number => {
    const value = distribution[key];
    if (value === null || distribution.count === 0) {
      missing.push(name);
      return 0;
    }
    return value;
  };
  const tickers = Object.values(report.tickers);
  const pooled = (
    pick: (ticker: (typeof tickers)[number]) => Distribution,
    key: keyof Distribution,
    name: string,
  ): number => {
    // The median of the tickers' own quantiles: a band that means the same for
    // a quiet ticker and a busy one, rather than one set by the busiest.
    const values = tickers
      .map(pick)
      .filter((distribution) => distribution.count > 0)
      .map((distribution) => distribution[key])
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const middle = values[Math.floor(values.length / 2)];
    if (middle === undefined) {
      missing.push(name);
      return 0;
    }
    return middle;
  };

  const { gaps, margin, advantage } = report.battles;
  return {
    engine: {
      scoring: {
        priceEdgeDivisor: scaled(at(gaps.adjustedReturn, 'p90', 'price gap')),
        volumeEdgeDivisor: scaled(at(gaps.relativeVolume, 'p90', 'volume gap')),
        ponsEdgeDivisor: scaled(at(gaps.ponsStrength, 'p90', 'Pons gap')),
      },
      momentum: {
        push: scaled(at(advantage, 'p50', 'advantage')),
        surge: scaled(at(advantage, 'p75', 'advantage')),
        dominance: scaled(at(advantage, 'p90', 'advantage')),
        comeback: scaled(at(advantage, 'p75', 'advantage')),
      },
      victory: {
        narrowMargin: scaled(at(margin, 'p25', 'margin')),
        decisiveMargin: scaled(at(margin, 'p75', 'margin')),
      },
    },
    confidence: {
      priceTrend: {
        strong: scaled(pooled((t) => t.lookback.adjustedReturn, 'p75', 'lookback return')),
        weak: scaled(pooled((t) => t.lookback.adjustedReturn, 'p25', 'lookback return')),
      },
      volumePulse: {
        rising: scaled(pooled((t) => t.lookback.relativeVolume, 'p75', 'lookback volume')),
        weak: scaled(pooled((t) => t.lookback.relativeVolume, 'p25', 'lookback volume')),
      },
      ponsActivity: {
        high: Math.round(
          pooled((t) => t.lookback.qualifiedPonsActivity, 'p75', 'lookback Pons'),
        ).toString(),
        medium: Math.round(
          pooled((t) => t.lookback.qualifiedPonsActivity, 'p25', 'lookback Pons'),
        ).toString(),
      },
      momentumStability: {
        stable: Math.round(pooled((t) => t.lookback.directionChanges, 'p25', 'direction changes')),
        mixed: Math.round(pooled((t) => t.lookback.directionChanges, 'p75', 'direction changes')),
      },
    },
    missing: [...new Set(missing)],
  };
}

/** A plain number back to `RATIO_SCALE`, as the decimal string a candidate carries. */
function scaled(value: number): string {
  return BigInt(Math.round(value * Number(RATIO_SCALE))).toString();
}
