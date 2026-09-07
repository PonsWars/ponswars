import { describe, expect, it } from 'vitest';
import {
  applyBasisPoints,
  BASIS_POINTS_DENOMINATOR,
  baseUnits,
  basisPoints,
  formatBaseUnits,
  minAmount,
  mulDivFloor,
  parseDecimalToBaseUnits,
  sumAmounts,
  tokenDecimals,
} from './money.js';

const SIX = tokenDecimals(6);
const EIGHTEEN = tokenDecimals(18);
const ZERO_DP = tokenDecimals(0);

describe('parseDecimalToBaseUnits', () => {
  it('converts the locked 0.2 SPY Secret reward at any token precision', () => {
    // §8.1 fixes the reward at 0.2 SPY. SPY decimals are OPEN, so the same
    // locked decimal must survive whatever precision the token turns out to use.
    expect(parseDecimalToBaseUnits('0.2', SIX)).toBe(200_000n);
    expect(parseDecimalToBaseUnits('0.2', EIGHTEEN)).toBe(200_000_000_000_000_000n);
  });

  it('converts whole numbers and zero', () => {
    expect(parseDecimalToBaseUnits('0', SIX)).toBe(0n);
    expect(parseDecimalToBaseUnits('1', SIX)).toBe(1_000_000n);
    expect(parseDecimalToBaseUnits('1', ZERO_DP)).toBe(1n);
    expect(parseDecimalToBaseUnits('12345', ZERO_DP)).toBe(12_345n);
  });

  it('converts the 0.001 SPY minimum claim baseline', () => {
    // §16.7 baseline. Still BASELINE rather than LOCKED, but it must convert
    // exactly whichever value is confirmed.
    expect(parseDecimalToBaseUnits('0.001', SIX)).toBe(1_000n);
  });

  it('pads fraction digits up to the token precision', () => {
    expect(parseDecimalToBaseUnits('0.5', SIX)).toBe(500_000n);
    expect(parseDecimalToBaseUnits('0.000001', SIX)).toBe(1n);
  });

  it('accepts excess fraction digits when they are all zero', () => {
    // No precision is lost, so this is safe to accept.
    expect(parseDecimalToBaseUnits('1.500', tokenDecimals(2))).toBe(150n);
    expect(parseDecimalToBaseUnits('0.2000000', SIX)).toBe(200_000n);
  });

  it('refuses to truncate significant digits', () => {
    // Silently dropping a digit off a reward amount is the exact failure this
    // module exists to prevent.
    expect(() => parseDecimalToBaseUnits('1.005', tokenDecimals(2))).toThrow(RangeError);
    expect(() => parseDecimalToBaseUnits('0.0000001', SIX)).toThrow(RangeError);
  });

  it.each([
    ['-1', 'negative'],
    ['+1', 'explicit plus'],
    ['1e5', 'scientific notation'],
    ['.5', 'leading dot'],
    ['1.', 'trailing dot'],
    ['01', 'leading zero'],
    ['', 'empty'],
    ['abc', 'non-numeric'],
    ['1 000', 'whitespace'],
    ['1,5', 'comma separator'],
    ['Infinity', 'infinity'],
    ['NaN', 'nan'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseDecimalToBaseUnits(input, SIX)).toThrow(TypeError);
  });

  it('never loses precision on values beyond Number.MAX_SAFE_INTEGER', () => {
    // 10 billion tokens at 18 decimals is far outside the safe float range.
    const parsed = parseDecimalToBaseUnits('10000000000.123456789012345678', EIGHTEEN);
    expect(parsed).toBe(10_000_000_000_123_456_789_012_345_678n);
    expect(formatBaseUnits(parsed, EIGHTEEN)).toBe('10000000000.123456789012345678');
  });
});

describe('formatBaseUnits', () => {
  it('renders base units back to a decimal string', () => {
    expect(formatBaseUnits(baseUnits(200_000n), SIX)).toBe('0.2');
    expect(formatBaseUnits(baseUnits(0n), SIX)).toBe('0');
    expect(formatBaseUnits(baseUnits(1_000_000n), SIX)).toBe('1');
    expect(formatBaseUnits(baseUnits(1n), SIX)).toBe('0.000001');
    expect(formatBaseUnits(baseUnits(12_345n), ZERO_DP)).toBe('12345');
  });

  it('renders negative amounts for ledger deltas', () => {
    expect(formatBaseUnits(baseUnits(-200_000n), SIX)).toBe('-0.2');
  });

  it('round-trips every canonical decimal', () => {
    for (const value of ['0', '0.2', '1', '0.001', '123.456', '0.000001']) {
      expect(formatBaseUnits(parseDecimalToBaseUnits(value, SIX), SIX)).toBe(value);
    }
  });
});

describe('mulDivFloor and applyBasisPoints', () => {
  it('applies the locked 80 percent distributable share', () => {
    // §16.3: 80% distributable, 20% carryover.
    const pool = parseDecimalToBaseUnits('1000', SIX);
    expect(applyBasisPoints(pool, basisPoints(8_000))).toBe(800_000_000n);
  });

  it('applies the locked 2 percent per-wallet cap', () => {
    // §16.6.
    const pool = parseDecimalToBaseUnits('1000', SIX);
    expect(applyBasisPoints(pool, basisPoints(200))).toBe(20_000_000n);
  });

  it('floors rather than rounding, so a pool can never over-allocate', () => {
    expect(applyBasisPoints(baseUnits(3n), basisPoints(5_000))).toBe(1n);
    expect(mulDivFloor(baseUnits(7n), 1n, 3n)).toBe(2n);
  });

  it('multiplies before dividing to preserve precision', () => {
    // Dividing first would floor to zero and lose the entire amount.
    expect(mulDivFloor(baseUnits(5n), 3n, 10n)).toBe(1n);
    expect(mulDivFloor(baseUnits(999n), 999n, 1_000n)).toBe(998n);
  });

  it('rejects a zero denominator', () => {
    expect(() => mulDivFloor(baseUnits(1n), 1n, 0n)).toThrow(RangeError);
  });

  it('exposes the basis-point denominator as a bigint', () => {
    expect(BASIS_POINTS_DENOMINATOR).toBe(10_000n);
  });
});

describe('guards', () => {
  it.each([-1, 37, 1.5, Number.NaN])('rejects invalid token decimals: %s', (value) => {
    expect(() => tokenDecimals(value)).toThrow(RangeError);
  });

  it.each([-1, 10_001, 1.5, Number.NaN])('rejects invalid basis points: %s', (value) => {
    expect(() => basisPoints(value)).toThrow(RangeError);
  });

  it('accepts the boundary values', () => {
    expect(tokenDecimals(0)).toBe(0);
    expect(tokenDecimals(36)).toBe(36);
    expect(basisPoints(0)).toBe(0);
    expect(basisPoints(10_000)).toBe(10_000);
  });
});

describe('aggregation', () => {
  it('sums amounts and returns zero for an empty list', () => {
    expect(sumAmounts([])).toBe(0n);
    expect(sumAmounts([baseUnits(1n), baseUnits(2n), baseUnits(3n)])).toBe(6n);
  });

  it('picks the smaller amount', () => {
    expect(minAmount(baseUnits(5n), baseUnits(3n))).toBe(3n);
    expect(minAmount(baseUnits(3n), baseUnits(5n))).toBe(3n);
    expect(minAmount(baseUnits(4n), baseUnits(4n))).toBe(4n);
  });
});
