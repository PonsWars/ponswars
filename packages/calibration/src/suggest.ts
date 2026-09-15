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
      readonly priceEdgeDivisor: string | null;
      readonly volumeEdgeDivisor: string | null;
      readonly ponsEdgeDivisor: string | null;
    };
    readonly momentum: {
      readonly push: string | null;
      readonly surge: string | null;
      readonly dominance: string | null;
      readonly comeback: string | null;
    };
    readonly victory: {
      readonly narrowMargin: string | null;
      readonly decisiveMargin: string | null;
    };
  };
  readonly confidence: {
    readonly priceTrend: { readonly strong: string | null; readonly weak: string | null };
    readonly volumePulse: { readonly rising: string | null; readonly weak: string | null };
    readonly ponsActivity: { readonly high: string | null; readonly medium: string | null };
    readonly momentumStability: { readonly stable: number | null; readonly mixed: number | null };
  };
  /** What the suggestion could not be read from; those values are `null`, never a guess. */
  readonly missing: readonly string[];
}

export function suggest(report: CalibrationReport): Suggestion {
  const missing: string[] = [];
  const at = (distribution: Distribution, key: keyof Distribution, name: string): number | null => {
    const value = distribution[key];
    if (value === null || distribution.count === 0) {
      missing.push(name);
      return null;
    }
    return value;
  };
  const tickers = Object.values(report.tickers);
  const pooled = (
    pick: (ticker: (typeof tickers)[number]) => Distribution,
    key: keyof Distribution,
    name: string,
  ): number | null => {
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
      return null;
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
        high:
          whole(
            pooled((t) => t.lookback.qualifiedPonsActivity, 'p75', 'lookback Pons'),
          )?.toString() ?? null,
        medium:
          whole(
            pooled((t) => t.lookback.qualifiedPonsActivity, 'p25', 'lookback Pons'),
          )?.toString() ?? null,
      },
      momentumStability: {
        stable: whole(pooled((t) => t.lookback.directionChanges, 'p25', 'direction changes')),
        mixed: whole(pooled((t) => t.lookback.directionChanges, 'p75', 'direction changes')),
      },
    },
    missing: [...new Set(missing)],
  };
}

/** A plain number back to `RATIO_SCALE`, as the decimal string a candidate carries. */
function scaled(value: number | null): string | null {
  return value === null ? null : BigInt(Math.round(value * Number(RATIO_SCALE))).toString();
}

function whole(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
