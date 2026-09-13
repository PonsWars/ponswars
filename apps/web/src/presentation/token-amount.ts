/**
 * A token amount in base units, written the way a player reads it (§34.1).
 *
 * `1234567890000000000000000` at 18 decimals is `1,234,567.89`. Whole units get
 * thousands separators; at most two decimal places follow, with trailing zeros
 * dropped.
 *
 * Exact, and **truncated, never rounded**. The arithmetic is `bigint` because
 * a balance of a million tokens at eighteen decimals is past what a `number`
 * holds exactly. And rounding can only ever round *up* into a claim: a wallet
 * holding 999,999.999 `$WAR` shown as `1,000,000` would read as eligible for a
 * Genesis card it cannot claim (§6).
 *
 * @throws RangeError for anything that is not a base-unit integer string, or
 *   decimals outside 0–36 — the server's schema already refuses both, so either
 *   reaching here is a bug worth hearing about.
 */
export function formatTokenAmount(baseUnits: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(baseUnits)) {
    throw new RangeError(`Not an amount in base units: ${baseUnits}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`Token decimals must be a whole number from 0 to 36: ${String(decimals)}`);
  }

  const amount = BigInt(baseUnits);
  const unit = 10n ** BigInt(decimals);
  const whole = (amount / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const shown = Math.min(decimals, 2);
  const fraction = ((amount % unit) / 10n ** BigInt(decimals - shown))
    .toString()
    .padStart(shown, '0')
    .replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
