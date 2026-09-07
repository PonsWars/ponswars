import type { Brand } from './brand.js';

/**
 * A token quantity in integer base units.
 *
 * Engineering standard §66.3: **never use JavaScript floating point for token
 * amounts.** `0.1 + 0.2 !== 0.3` is not an acceptable failure mode for a system
 * that reserves and pays real SPY. Everything monetary is a `bigint` of base
 * units from ingress to settlement; decimal strings exist only at the
 * presentation boundary.
 */
export type BaseUnits = Brand<bigint, 'BaseUnits'>;

/**
 * Number of decimal places a token uses.
 *
 * This is `OPEN` for SPY — see `docs/OPEN_PARAMETERS.md`. It is read from chain
 * at startup and never assumed to be 18.
 */
export type TokenDecimals = Brand<number, 'TokenDecimals'>;

/** Basis points: 1/100th of a percent. 10 000 bps = 100%. */
export type BasisPoints = Brand<number, 'BasisPoints'>;

/** Denominator for basis-point arithmetic. */
export const BASIS_POINTS_DENOMINATOR = 10_000n;

/** Wraps a raw `bigint` of base units. */
export function baseUnits(value: bigint): BaseUnits {
  return value as BaseUnits;
}

/** Wraps a token decimal count, rejecting values outside the ERC-20 range. */
export function tokenDecimals(value: number): TokenDecimals {
  if (!Number.isInteger(value) || value < 0 || value > 36) {
    throw new RangeError(`Token decimals must be an integer in [0, 36], received ${String(value)}`);
  }
  return value as TokenDecimals;
}

/** Wraps a basis-point value, rejecting anything outside [0, 10 000]. */
export function basisPoints(value: number): BasisPoints {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(
      `Basis points must be an integer in [0, 10000], received ${String(value)}`,
    );
  }
  return value as BasisPoints;
}

/**
 * Matches an unsigned decimal literal: `0`, `12`, `0.2`, `12.3400`.
 *
 * Scientific notation, a leading `+`/`-`, a bare `.5` and a trailing `1.` are
 * all rejected. Being strict here is deliberate: a value that reaches this
 * function in an unexpected shape is a bug upstream, and silently coercing it
 * would hide the bug behind a plausible-looking number.
 */
const DECIMAL_LITERAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Converts an unsigned decimal string to integer base units, exactly.
 *
 * The conversion runs entirely in `bigint`; the input never becomes a `number`,
 * so no rounding can occur. Excess fraction digits are rejected rather than
 * truncated — quietly dropping a digit off a reward amount is precisely the
 * failure this codebase must not have.
 *
 * @throws TypeError if `value` is not a well-formed unsigned decimal literal.
 * @throws RangeError if `value` carries more fraction digits than the token can
 *   represent and those digits are not all zero.
 */
export function parseDecimalToBaseUnits(value: string, decimals: TokenDecimals): BaseUnits {
  const match = DECIMAL_LITERAL.exec(value);
  if (match === null) {
    throw new TypeError(
      `Expected an unsigned decimal literal such as "0.2", received ${JSON.stringify(value)}`,
    );
  }

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';

  let significant = fraction;
  if (fraction.length > decimals) {
    significant = fraction.slice(0, decimals);
    const dropped = fraction.slice(decimals);
    if (/[1-9]/.test(dropped)) {
      throw new RangeError(
        `${value} needs ${String(fraction.length)} decimal places but the token has ` +
          `${String(decimals)}; refusing to truncate significant digits`,
      );
    }
  }

  const padded = significant.padEnd(decimals, '0');
  return baseUnits(BigInt(whole + padded));
}

/**
 * Renders base units as a decimal string for display only.
 *
 * Trailing fractional zeros are trimmed, so 0.200000 renders as `0.2`.
 */
export function formatBaseUnits(amount: BaseUnits, decimals: TokenDecimals): string {
  const raw: bigint = amount;
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  const digits = magnitude.toString().padStart(decimals + 1, '0');

  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');

  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}

/**
 * Computes `(amount * numerator) / denominator` with a single floored division.
 *
 * Multiplying before dividing keeps full precision; flooring once at the end
 * means a distribution can never allocate more than the pool holds. The
 * remainder that flooring leaves behind is not lost — the Rewards Engine
 * carries it forward (§16.7).
 */
export function mulDivFloor(amount: BaseUnits, numerator: bigint, denominator: bigint): BaseUnits {
  if (denominator === 0n) {
    throw new RangeError('Division by zero in mulDivFloor');
  }
  return baseUnits((amount * numerator) / denominator);
}

/** Applies a basis-point fraction to an amount, flooring the result. */
export function applyBasisPoints(amount: BaseUnits, bps: BasisPoints): BaseUnits {
  return mulDivFloor(amount, BigInt(bps), BASIS_POINTS_DENOMINATOR);
}

/**
 * Floor of the integer square root, computed entirely in `bigint`.
 *
 * `Math.sqrt` returns a double, and a double cannot represent every integer
 * this system handles — nor is its last bit guaranteed identical across
 * engines. Standard §66.4 requires one deterministic numerical strategy shared
 * by production, replay and tests, and reward weighting is `sqrt(WP)` (§16.5),
 * so the square root has to be exact and reproducible rather than merely close.
 *
 * Newton's method on integers: it converges downward to the floor and stops,
 * with no floating point anywhere in the loop.
 *
 * @throws RangeError for a negative input.
 */
export function integerSqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError(`integerSqrt is undefined for negative input ${value.toString()}`);
  }
  if (value < 2n) {
    return value;
  }

  let previous = value;
  let current = (value + 1n) / 2n;
  while (current < previous) {
    previous = current;
    current = (current + value / current) / 2n;
  }
  return previous;
}

/** Returns the smaller of two amounts. */
export function minAmount(left: BaseUnits, right: BaseUnits): BaseUnits {
  return left <= right ? left : right;
}

/** Sums a list of amounts. Returns zero for an empty list. */
export function sumAmounts(amounts: readonly BaseUnits[]): BaseUnits {
  let total = 0n;
  for (const amount of amounts) {
    total += amount;
  }
  return baseUnits(total);
}
