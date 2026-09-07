/**
 * Primitive parsers for environment values.
 *
 * Every environment value arrives as a string. Each parser either returns a
 * well-typed value or an error message explaining what was expected — it never
 * substitutes a fallback, because a fallback for an `OPEN` parameter is a
 * silent product decision (§102).
 */

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error });

/** A non-empty string with surrounding whitespace removed. */
export function parseString(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fail('expected a non-empty string') : ok(trimmed);
}

/** A base-10 integer, optionally bounded. */
export function parseInteger(
  raw: string,
  bounds?: { readonly min?: number; readonly max?: number },
): ParseResult<number> {
  const trimmed = raw.trim();
  if (!/^-?(0|[1-9][0-9]*)$/.test(trimmed)) {
    return fail('expected a base-10 integer');
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return fail('integer is outside the safe range');
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    return fail(`expected an integer >= ${String(bounds.min)}`);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    return fail(`expected an integer <= ${String(bounds.max)}`);
  }
  return ok(value);
}

/** A positive duration in milliseconds. */
export function parseDurationMs(raw: string): ParseResult<number> {
  return parseInteger(raw, { min: 1 });
}

/**
 * An unsigned decimal literal such as `0.001`.
 *
 * Kept as a string rather than a number: the token precision it will be
 * converted against is itself configuration, and going through a float would
 * defeat the exactness `parseDecimalToBaseUnits` exists to provide (§66.3).
 */
export function parseDecimalString(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(trimmed)) {
    return fail('expected an unsigned decimal literal such as "0.001"');
  }
  return ok(trimmed);
}

/**
 * A 20-byte EVM address, normalized to lowercase.
 *
 * Lowercasing here means an address compares equal regardless of the checksum
 * casing it was configured with.
 */
export function parseAddress(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return fail('expected a 0x-prefixed 20-byte hex address');
  }
  return ok(trimmed.toLowerCase());
}

/** An absolute URL restricted to an allowed protocol set. */
export function parseUrl(raw: string, protocols: readonly string[]): ParseResult<string> {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail('expected an absolute URL');
  }
  if (!protocols.includes(parsed.protocol)) {
    return fail(`expected one of the protocols ${protocols.join(', ')}`);
  }
  return ok(trimmed);
}

/** One of a fixed set of values. */
export function parseEnum<T extends string>(raw: string, allowed: readonly T[]): ParseResult<T> {
  const trimmed = raw.trim();
  const match = allowed.find((candidate) => candidate === trimmed);
  return match === undefined ? fail(`expected one of ${allowed.join(', ')}`) : ok(match);
}

/** A strict boolean: exactly `true` or `false`, never a truthy string. */
export function parseBoolean(raw: string): ParseResult<boolean> {
  const trimmed = raw.trim();
  if (trimmed === 'true') return ok(true);
  if (trimmed === 'false') return ok(false);
  return fail('expected exactly "true" or "false"');
}
