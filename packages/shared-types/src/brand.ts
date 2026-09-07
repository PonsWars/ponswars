/**
 * Nominal typing helper.
 *
 * A `RoundId` and a `BattleId` are both strings at runtime, and passing one
 * where the other is expected is a real class of bug in a system that threads
 * identifiers through five services and a WebSocket protocol. Branding makes
 * that mix-up a compile error.
 *
 * The brand exists only in the type system — it is erased at runtime and adds
 * no allocation, no wrapper object and no serialization cost.
 */

declare const BRAND: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [BRAND]: TBrand };

/**
 * Applies a brand without validating the value.
 *
 * Only call this where the value is already known to be well-formed:
 *
 * - a literal in a test fixture,
 * - a value that a `@ponswars/schemas` parser has just validated,
 * - a value read back from a column with a database-level constraint.
 *
 * Never call it on unvalidated input crossing a process boundary. Engineering
 * standard §66.2 puts validation at ingress, and this function is deliberately
 * not that boundary.
 */
export function unsafeBrand<TBranded extends Brand<unknown, string>>(
  value: TBranded extends Brand<infer TValue, string> ? TValue : never,
): TBranded {
  return value as TBranded;
}
