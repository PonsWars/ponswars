import { createHash } from 'node:crypto';
import {
  CARD_CATALOG,
  cardsOfRarity,
  GENESIS_DOMAIN_SEPARATOR,
  rarityForSlot,
  RARITY_USES,
  RNG_SLOT_COUNT,
  type CardType,
  type Rarity,
} from '@ponswars/shared-types';
import { DeterministicPrng } from './prng.js';

/**
 * Genesis RNG execution (§9).
 *
 * The seed is *"finalized future block hash + wallet + permanent Genesis
 * request ID/nonce + `PONSWARS_GENESIS_V1` domain separator"*, and the result
 * must be deterministic, replayable, wallet-specific, un-rerollable, and
 * impossible for the backend to steer after observing the entropy.
 *
 * This module has no branches a backend could take. Given the four inputs there
 * is exactly one outcome, computable by anyone holding them — which is what
 * makes a Genesis result auditable rather than an assertion.
 */

/** The four inputs that determine a Genesis outcome. */
export interface GenesisSeedInput {
  /**
   * Hash of a block finalized *after* the request was committed (§9).
   *
   * Future-block entropy is what stops a wallet from choosing a favourable
   * moment to request: the value does not exist yet when the request is made.
   */
  readonly finalizedBlockHash: string;
  /** The claiming wallet. Normalized to lowercase so casing cannot fork a result. */
  readonly wallet: string;
  /**
   * Permanent Genesis request identifier.
   *
   * Permanent is the operative word: a retried request reuses the same ID and
   * therefore the same outcome. Issuing a new ID would be a reroll, which §9
   * forbids.
   */
  readonly requestId: string;
}

function normalizeHex(value: string, label: string): string {
  const withoutPrefix = /^0x/i.test(value) ? value.slice(2) : value;
  if (withoutPrefix.length === 0 || !/^[0-9a-fA-F]+$/.test(withoutPrefix)) {
    throw new TypeError(`${label} must be a non-empty hex string`);
  }
  if (withoutPrefix.length % 2 !== 0) {
    throw new TypeError(`${label} must contain a whole number of bytes`);
  }
  return withoutPrefix.toLowerCase();
}

/**
 * Derives the Genesis seed.
 *
 * Fields are length-prefixed before hashing so no two different input tuples
 * can produce the same byte string. Without prefixes, a wallet ending in some
 * characters and a request ID beginning with them would concatenate to the same
 * preimage as a different pairing — an unlikely collision, but one that would
 * silently give two wallets the same card.
 */
export function deriveGenesisSeed(input: GenesisSeedInput): string {
  const blockHash = normalizeHex(input.finalizedBlockHash, 'Finalized block hash');
  const wallet = normalizeHex(input.wallet, 'Wallet address');
  if (input.requestId.length === 0) {
    throw new TypeError('Genesis request id must not be empty');
  }

  const hash = createHash('sha256').update(Buffer.from(GENESIS_DOMAIN_SEPARATOR, 'utf8'));

  for (const field of [
    Buffer.from(blockHash, 'hex'),
    Buffer.from(wallet, 'hex'),
    Buffer.from(input.requestId, 'utf8'),
  ]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(field.length);
    hash.update(length).update(field);
  }

  return hash.digest('hex');
}

/** A finalized Genesis outcome. */
export interface GenesisOutcome {
  /** The slot the entropy reduced to, in `[0, 1_000_000)`. Retained as evidence. */
  readonly slot: number;
  readonly rarity: Rarity;
  readonly cardType: CardType;
  /** The seed the outcome came from, so a third party can recompute it (§26). */
  readonly seed: string;
  /**
   * Whether Secret was funded when the result was committed (§8.3).
   *
   * Part of the evidence: the same slot yields a different rarity depending on
   * coverage, so a replay needs to know what coverage was at commit time.
   */
  readonly secretAvailable: boolean;
}

/**
 * Resolves a Genesis request to a card.
 *
 * Two draws from one stream: the rarity slot, then the card within that rarity.
 * §9.2 makes a three-card rarity an even third each and a two-card rarity a
 * straight 50/50, which a uniform draw over the rarity's catalog entries gives
 * directly.
 *
 * @param secretAvailable Whether the vault covered a full reward at the moment
 *   the result was committed (§8.3). Evaluated **before** the reveal — a user
 *   must never see a Secret they cannot be paid.
 */
export function resolveGenesis(input: GenesisSeedInput, secretAvailable: boolean): GenesisOutcome {
  const seed = deriveGenesisSeed(input);
  const prng = new DeterministicPrng(seed, GENESIS_DOMAIN_SEPARATOR);

  const slot = prng.nextBelow(RNG_SLOT_COUNT);
  const rarity = rarityForSlot(slot, secretAvailable);

  const candidates = cardsOfRarity(rarity);
  /* c8 ignore next 3 -- unreachable: every rarity has at least one card. */
  if (candidates.length === 0) {
    throw new Error(`No cards defined for rarity ${rarity}`);
  }
  const chosen = candidates[prng.nextBelow(candidates.length)];
  /* c8 ignore next 3 -- unreachable: the index is drawn within range. */
  if (chosen === undefined) {
    throw new Error(`Card selection out of range for rarity ${rarity}`);
  }

  return {
    slot,
    rarity,
    cardType: chosen.type,
    seed,
    secretAvailable,
  };
}

/**
 * Recomputes an outcome and checks it against a recorded one.
 *
 * The audit path (§26, §9): anyone holding the four inputs can verify a
 * published Genesis result without trusting the service that produced it.
 */
export function verifyGenesis(
  input: GenesisSeedInput,
  secretAvailable: boolean,
  recorded: Pick<GenesisOutcome, 'slot' | 'rarity' | 'cardType'>,
): boolean {
  const recomputed = resolveGenesis(input, secretAvailable);
  return (
    recomputed.slot === recorded.slot &&
    recomputed.rarity === recorded.rarity &&
    recomputed.cardType === recorded.cardType
  );
}

/**
 * Initial charges a card grants (§7.1).
 *
 * Reads the catalog and the rarity table rather than restating either. The
 * counts live in `@ponswars/shared-types`; repeating them here would create a
 * second place to change them, which §65.1 exists to prevent.
 */
export function initialUsesFor(cardType: CardType): number {
  return RARITY_USES[CARD_CATALOG[cardType].rarity];
}
