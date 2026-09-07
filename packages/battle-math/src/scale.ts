/**
 * Fixed-point scales shared by the scoring engine.
 *
 * Standard §66.4 requires one deterministic numerical strategy across replay,
 * production and tests. Every quantity below is a `bigint` of scaled units, so
 * an auditor reimplementing the engine gets identical integers rather than
 * results that agree to some tolerance.
 */

/** Scale for ratios, returns and edges. One unit is 1e-6. */
export const RATIO_SCALE = 1_000_000n;

/** Scale for battle points. 45 points is `45n * POINT_SCALE`. */
export const POINT_SCALE = 1_000_000n;

/** Converts a whole number of battle points into scaled points. */
export function points(whole: number): bigint {
  return BigInt(whole) * POINT_SCALE;
}

/** Converts a decimal ratio given in millionths. `ratio(1_500_000n)` is 1.5. */
export function ratio(scaled: bigint): bigint {
  return scaled;
}

/** Clamps a scaled value into `[-RATIO_SCALE, RATIO_SCALE]`. */
export function clampUnit(scaled: bigint): bigint {
  if (scaled > RATIO_SCALE) return RATIO_SCALE;
  if (scaled < -RATIO_SCALE) return -RATIO_SCALE;
  return scaled;
}

/**
 * Divides two scaled values, returning a scaled result.
 *
 * Floors toward negative infinity rather than toward zero, so the direction of
 * rounding does not flip with the sign of the numerator. A rounding rule that
 * changed behaviour for negative returns would make the engine treat a falling
 * market differently from a rising one.
 */
export function divScaled(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero in divScaled');
  }
  const scaled = numerator * RATIO_SCALE;
  const quotient = scaled / denominator;
  // BigInt division truncates toward zero; correct it to a true floor.
  if (scaled % denominator !== 0n && scaled < 0n !== denominator < 0n) {
    return quotient - 1n;
  }
  return quotient;
}

/** Renders scaled points as a decimal string, for evidence and display only. */
export function formatPoints(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / POINT_SCALE;
  const fraction = (magnitude % POINT_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  const rendered = fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
  return negative ? `-${rendered}` : rendered;
}
