import { describe, expect, it } from 'vitest';
import { Sample, tally } from './distribution.js';

describe('Sample', () => {
  it('reads quantiles by nearest rank', () => {
    const sample = new Sample();
    for (let value = 10; value >= 1; value -= 1) {
      sample.add(value);
    }
    expect(sample.summary()).toEqual({
      count: 10,
      min: 1,
      p10: 1,
      p25: 3,
      p50: 5,
      p75: 8,
      p90: 9,
      max: 10,
    });
  });

  it('says nothing about an empty sample, and ignores what is not a number', () => {
    const sample = new Sample();
    sample.add(Number.NaN);
    sample.add(Infinity);
    expect(sample.summary()).toMatchObject({ count: 0, p50: null });
    expect(() => sample.quantile(2)).not.toThrow();
    sample.add(1);
    expect(() => sample.quantile(2)).toThrow(RangeError);
  });
});

describe('tally', () => {
  it('starts every label at zero', () => {
    expect(tally(['A', 'B'] as const)).toEqual({ A: 0, B: 0 });
  });
});
