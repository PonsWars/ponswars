import type { BaseUnits } from './money.js';

/**
 * Secret Stock Drop and the Secret Stock Vault.
 *
 * Masterplan §8. The Secret is not a stronger card — it is a distinct Genesis
 * outcome that grants a real tokenized-stock reward (§8.1).
 */

/**
 * The fixed Secret reward, as a decimal SPY amount (§8.1).
 *
 * A decimal string because SPY decimals are `OPEN`. Convert with
 * `parseDecimalToBaseUnits` once the token is known — never with a float.
 */
export const SECRET_REWARD_SPY_DECIMAL = '0.2';

/**
 * Coverage must be secured before the reveal (§8.4).
 *
 * The order is: acquire the reservation lock, re-check coverage, create the
 * onchain entitlement, reserve exactly the reward, commit the Genesis result,
 * and only then reveal. *"A user must never see a successful Secret reveal
 * without secured reward coverage."*
 */
export const SECRET_RESERVE_BEFORE_REVEAL = true;

/**
 * Public vault state (§8.6).
 *
 * Deliberately coarse. The UI should not emphasise remaining Secret inventory,
 * even though the onchain balance stays independently inspectable.
 */
export const SECRET_VAULT_PUBLIC_STATES = ['ACTIVE', 'DORMANT'] as const;

export type SecretVaultPublicState = (typeof SECRET_VAULT_PUBLIC_STATES)[number];

/**
 * Entitlement lifecycle (§8.5).
 *
 * Reserved funds cannot be withdrawn by admin and cannot be reassigned to
 * another winner. After a claim the trophy stays permanently in the profile.
 */
export const SECRET_ENTITLEMENT_STATES = ['RESERVED', 'CLAIMED'] as const;

export type SecretEntitlementState = (typeof SECRET_ENTITLEMENT_STATES)[number];

/**
 * Coverage available for a new reservation (§8.3).
 *
 * `availableSecretBalance = vaultBalance - reservedBalance`. Already-reserved
 * SPY belongs to a specific winner and is never counted as available.
 */
export function availableSecretBalance(
  vaultBalance: BaseUnits,
  reservedBalance: BaseUnits,
): BaseUnits {
  const available = vaultBalance - reservedBalance;
  return (available > 0n ? available : 0n) as BaseUnits;
}

/**
 * Whether Secret RNG is currently active (§8.3).
 *
 * Active only while coverage is at least one full reward. Below that the 0.1%
 * is reassigned to Legendary and resumes automatically once refunded — see
 * `RARITY_RATE_BPS_SECRET_DISABLED`.
 *
 * If exactly one reward remains, one final Secret may still be reserved; the
 * vault becomes dormant immediately afterwards.
 */
export function isSecretRngActive(available: BaseUnits, rewardAmount: BaseUnits): boolean {
  return available >= rewardAmount;
}

/** Public vault state for a coverage level (§8.6). */
export function secretVaultPublicState(
  available: BaseUnits,
  rewardAmount: BaseUnits,
): SecretVaultPublicState {
  return isSecretRngActive(available, rewardAmount) ? 'ACTIVE' : 'DORMANT';
}
