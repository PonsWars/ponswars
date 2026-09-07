/**
 * Genesis Card eligibility, rarity distribution and deterministic RNG mapping.
 *
 * Masterplan §6 (eligibility), §7 (pool), §8 (Secret), §9 (RNG execution).
 */

// ---------------------------------------------------------------------------
// Eligibility — LOCKED (§6)
// ---------------------------------------------------------------------------

/**
 * Minimum `$WAR` balance for a Genesis claim, as a decimal token amount.
 *
 * A decimal string rather than a number: `$WAR` decimals are `OPEN`, so the
 * base-unit threshold can only be computed once the token is known. Convert
 * with `parseDecimalToBaseUnits` at the point of use — never with `* 10 ** d`.
 */
export const GENESIS_WAR_THRESHOLD_DECIMAL = '1000000';

/**
 * There is no holding-duration requirement (§6).
 *
 * V1 accepts the trade-off knowingly: instant onboarding over a 24-hour
 * anti-sybil gate. Recorded as a constant so nobody reintroduces a waiting
 * period believing it was an oversight.
 */
export const GENESIS_HOLDING_DURATION_REQUIRED = false;

/** One eligible wallet receives exactly one Genesis Card, forever (§6). */
export const GENESIS_CLAIMS_PER_WALLET = 1;

/** Genesis Cards are non-transferable and are not tradable NFTs in V1 (§6, §19). */
export const GENESIS_TRANSFERABLE = false;

// ---------------------------------------------------------------------------
// Rarity — LOCKED (§7.1)
// ---------------------------------------------------------------------------

export const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'SECRET'] as const;

export type Rarity = (typeof RARITIES)[number];

/**
 * Drop rates in basis points (§7.1).
 *
 * Basis points rather than percentages so the distribution is exact integer
 * arithmetic. `1.9%` and `0.1%` are not exactly representable in binary
 * floating point; `190` and `10` are, and they sum to exactly `10_000`.
 */
export const RARITY_RATE_BPS: Readonly<Record<Rarity, number>> = {
  COMMON: 5_000,
  UNCOMMON: 2_800,
  RARE: 1_400,
  EPIC: 600,
  LEGENDARY: 190,
  SECRET: 10,
} as const;

/**
 * Rates while the Secret Vault lacks coverage (§8.3).
 *
 * Secret's 10 bps are reassigned to Legendary — 2.00% Legendary, 0% Secret —
 * and normal distribution resumes automatically once the vault is refunded.
 */
export const RARITY_RATE_BPS_SECRET_DISABLED: Readonly<Record<Rarity, number>> = {
  COMMON: 5_000,
  UNCOMMON: 2_800,
  RARE: 1_400,
  EPIC: 600,
  LEGENDARY: 200,
  SECRET: 0,
} as const;

/**
 * Card charges granted per rarity (§7.1).
 *
 * Secret grants one reward claim rather than battle charges — it is a distinct
 * Genesis outcome, not a stronger buff (§8.1).
 */
export const RARITY_USES: Readonly<Record<Rarity, number>> = {
  COMMON: 20,
  UNCOMMON: 15,
  RARE: 10,
  EPIC: 5,
  LEGENDARY: 3,
  SECRET: 1,
} as const;

// ---------------------------------------------------------------------------
// Deterministic RNG mapping — LOCKED (§9)
// ---------------------------------------------------------------------------

/** The fixed slot space the entropy is reduced into (§9.1). */
export const RNG_SLOT_COUNT = 1_000_000;

/**
 * Basis points scale to slots exactly: 10 000 bps over 1 000 000 slots means
 * one basis point is one hundred slots, with no remainder anywhere.
 */
export const SLOTS_PER_BASIS_POINT = 100;

/**
 * Domain separator mixed into the Genesis seed (§9).
 *
 * Prevents a signature or entropy commitment from being replayed across
 * wallets, requests, chains or environments (§20).
 */
export const GENESIS_DOMAIN_SEPARATOR = 'PONSWARS_GENESIS_V1';

/** An inclusive slot range `[start, end]`. */
export interface SlotRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Builds the contiguous slot table for a rate distribution.
 *
 * Ranges are derived from the rates rather than transcribed beside them, so
 * the two can never disagree. A rarity with a zero rate yields an empty range
 * and is unreachable.
 */
export function buildSlotTable(
  rates: Readonly<Record<Rarity, number>>,
): Readonly<Record<Rarity, SlotRange>> {
  const table = {} as Record<Rarity, SlotRange>;
  let cursor = 0;
  for (const rarity of RARITIES) {
    const width = rates[rarity] * SLOTS_PER_BASIS_POINT;
    table[rarity] = { start: cursor, end: cursor + width - 1 };
    cursor += width;
  }
  return table;
}

/** Slot table while Secret is funded (§9.1). */
export const RARITY_SLOT_TABLE = buildSlotTable(RARITY_RATE_BPS);

/** Slot table while Secret is unfunded — its slots fall to Legendary (§8.3). */
export const RARITY_SLOT_TABLE_SECRET_DISABLED = buildSlotTable(RARITY_RATE_BPS_SECRET_DISABLED);

/**
 * Maps an entropy-derived slot to a rarity.
 *
 * Pure and total: the same slot and the same availability always yield the same
 * rarity, which is what makes a Genesis result replayable and auditable (§9).
 * The backend cannot choose a preferred outcome after observing the entropy,
 * because there is no choice to make here.
 *
 * @param slot Integer in `[0, RNG_SLOT_COUNT)`.
 * @param secretAvailable Whether the vault currently covers a `0.2 SPY`
 *   reservation (§8.3). Evaluated before the reveal, never after.
 * @throws RangeError if `slot` is outside the slot space.
 */
export function rarityForSlot(slot: number, secretAvailable: boolean): Rarity {
  if (!Number.isInteger(slot) || slot < 0 || slot >= RNG_SLOT_COUNT) {
    throw new RangeError(
      `Genesis slot must be an integer in [0, ${String(RNG_SLOT_COUNT)}), received ${String(slot)}`,
    );
  }
  const table = secretAvailable ? RARITY_SLOT_TABLE : RARITY_SLOT_TABLE_SECRET_DISABLED;
  for (const rarity of RARITIES) {
    const range = table[rarity];
    if (slot >= range.start && slot <= range.end) {
      return rarity;
    }
  }
  /* c8 ignore next 2 -- unreachable: the table covers the whole slot space. */
  throw new RangeError(`No rarity covers slot ${String(slot)}`);
}

// ---------------------------------------------------------------------------
// Genesis request lifecycle
// ---------------------------------------------------------------------------

/**
 * States a Genesis request moves through (§47.4, §110.7).
 *
 * `COMMITTED` is the point of no return: once entropy is committed the outcome
 * is fixed. §110.7 forbids implying that a refresh or retry could produce a
 * different rarity after that point, and a disconnected client recovers the
 * same request rather than starting a new one.
 */
export const GENESIS_REQUEST_STATES = ['PENDING', 'COMMITTED', 'FINALIZED', 'FAILED'] as const;

export type GenesisRequestState = (typeof GENESIS_REQUEST_STATES)[number];

export const GENESIS_REQUEST_TRANSITIONS: Readonly<
  Record<GenesisRequestState, readonly GenesisRequestState[]>
> = {
  PENDING: ['COMMITTED', 'FAILED'],
  // A committed request can only finalize. It never fails back to a retry,
  // because that would be a reroll of an already-determined outcome (§9).
  COMMITTED: ['FINALIZED'],
  FINALIZED: [],
  FAILED: [],
} as const;

export function canTransitionGenesisRequest(
  from: GenesisRequestState,
  to: GenesisRequestState,
): boolean {
  return GENESIS_REQUEST_TRANSITIONS[from].includes(to);
}
