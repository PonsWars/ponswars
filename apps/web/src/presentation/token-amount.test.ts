import { describe, expect, it } from 'vitest';
import { formatTokenAmount } from './token-amount.js';

const WAR = 18;
const units = (whole: bigint, fraction = 0n): string => (whole * 10n ** 18n + fraction).toString();

describe('formatTokenAmount', () => {
  it('writes whole units with thousands separators', () => {
    expect(formatTokenAmount(units(12_400n), WAR)).toBe('12,400');
    expect(formatTokenAmount(units(1_234_567n), WAR)).toBe('1,234,567');
    expect(formatTokenAmount(units(999n), WAR)).toBe('999');
  });

  it('is zero for nothing, not an empty string', () => {
    expect(formatTokenAmount('0', WAR)).toBe('0');
  });

  it('shows at most two decimal places, without trailing zeros', () => {
    expect(formatTokenAmount(units(5n, 890_000_000_000_000_000n), WAR)).toBe('5.89');
    expect(formatTokenAmount(units(5n, 500_000_000_000_000_000n), WAR)).toBe('5.5');
    expect(formatTokenAmount(units(5n, 50_000_000_000_000_000n), WAR)).toBe('5.05');
  });

  it('truncates, so a balance just under a million never reads as a million (§6)', () => {
    const justUnder = units(999_999n, 999_999_999_999_999_999n);

    expect(formatTokenAmount(justUnder, WAR)).toBe('999,999.99');
  });

  it('shows a dust balance as zero rather than rounding it up', () => {
    expect(formatTokenAmount('1', WAR)).toBe('0');
  });

  it('is exact past the range a number holds', () => {
    // 2^53 is about 9.007e15; this is 1.2e27.
    expect(formatTokenAmount('1234567890123456789012345678', WAR)).toBe('1,234,567,890.12');
  });

  it('handles tokens with few or no decimals', () => {
    expect(formatTokenAmount('123456', 6)).toBe('0.12');
    expect(formatTokenAmount('1234', 0)).toBe('1,234');
    expect(formatTokenAmount('1234', 1)).toBe('123.4');
  });

  it('refuses what is not a base-unit amount', () => {
    for (const bad of ['', '-1', '1.5', '007', 'abc']) {
      expect(() => formatTokenAmount(bad, WAR)).toThrow(RangeError);
    }
    expect(() => formatTokenAmount('1', 37)).toThrow(RangeError);
    expect(() => formatTokenAmount('1', -1)).toThrow(RangeError);
  });
});
