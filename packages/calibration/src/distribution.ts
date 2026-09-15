/**
 * How a measured quantity is spread.
 *
 * Quantiles rather than a mean and deviation: market inputs are heavy-tailed,
 * and a bound chosen from a mean would be set by the one minute a whale traded.
 * Reported as plain numbers — the report is read by a person choosing a value,
 * and the value they choose goes back into configuration as an integer.
 */

export interface Distribution {
  readonly count: number;
  readonly min: number | null;
  readonly p10: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}

/** Collects values, then summarises them. */
export class Sample {
  private readonly values: number[] = [];

  add(value: number): void {
    if (Number.isFinite(value)) {
      this.values.push(value);
    }
  }

  get count(): number {
    return this.values.length;
  }

  /** The value at quantile `q` in [0, 1], by nearest rank; `null` when empty. */
  quantile(q: number): number | null {
    return quantileOf(this.sorted(), q);
  }

  summary(): Distribution {
    const sorted = this.sorted();
    return {
      count: sorted.length,
      min: quantileOf(sorted, 0),
      p10: quantileOf(sorted, 0.1),
      p25: quantileOf(sorted, 0.25),
      p50: quantileOf(sorted, 0.5),
      p75: quantileOf(sorted, 0.75),
      p90: quantileOf(sorted, 0.9),
      max: quantileOf(sorted, 1),
    };
  }

  private sorted(): number[] {
    return [...this.values].sort((a, b) => a - b);
  }
}

function quantileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  if (q < 0 || q > 1) {
    throw new RangeError('A quantile is between 0 and 1');
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Counts of each label seen, every label present even at zero. */
export function tally<T extends string>(labels: readonly T[]): Record<T, number> {
  return Object.fromEntries(labels.map((label) => [label, 0])) as Record<T, number>;
}
