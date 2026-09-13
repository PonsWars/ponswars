import { initialUsesFor, resolveGenesis, type GenesisOutcome } from '@ponswars/battle-math';
import {
  canTransitionGenesisRequest,
  GENESIS_CLAIMS_PER_WALLET,
  GENESIS_WAR_THRESHOLD_DECIMAL,
  parseDecimalToBaseUnits,
  type BaseUnits,
  type GenesisRequestState,
  type Rarity,
  type TokenDecimals,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';

/**
 * The Genesis claim lifecycle (§6, §8.4, §47.4, §76).
 *
 * The service exists to enforce one ordering that nothing else can:
 *
 * > §8.4 — acquire the reservation lock, re-check coverage, create the onchain
 * > entitlement, reserve exactly the reward, commit the Genesis result, and
 * > **only then** reveal.
 *
 * §76.5 restates it: a Secret result is not user-visible until the entitlement
 * exists, the reservation succeeded and its reference is committed. *"If
 * reservation cannot be completed, the service must ... not show a false Secret
 * success."*
 *
 * So `reveal` is a separate step from `resolve`, and the type system makes the
 * order explicit: a resolved Secret is not a revealable result until it has been
 * through reservation.
 */

// ---------------------------------------------------------------------------
// Eligibility (§6)
// ---------------------------------------------------------------------------

export type EligibilityVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: 'INSUFFICIENT_WAR' | 'ALREADY_CLAIMED' };

export interface EligibilityInput {
  readonly warBalance: BaseUnits;
  readonly warDecimals: TokenDecimals;
  readonly hasClaimedBefore: boolean;
}

/**
 * Decides whether a wallet may open a Genesis Card.
 *
 * §6: at least 1,000,000 `$WAR` held **now**, and never claimed before. There is
 * no holding-duration gate — V1 accepts that trade-off knowingly for instant
 * onboarding, and a waiting period must not be reintroduced by accident.
 *
 * Selling `$WAR` after claiming does not reset eligibility, and reacquiring it
 * does not create a second claim; both follow from `hasClaimedBefore` being
 * permanent rather than derived from the current balance.
 */
export function checkEligibility(input: EligibilityInput): EligibilityVerdict {
  if (input.hasClaimedBefore) {
    return { eligible: false, reason: 'ALREADY_CLAIMED' };
  }
  const threshold = parseDecimalToBaseUnits(GENESIS_WAR_THRESHOLD_DECIMAL, input.warDecimals);
  if (input.warBalance < threshold) {
    return { eligible: false, reason: 'INSUFFICIENT_WAR' };
  }
  return { eligible: true };
}

/** The threshold in base units, for a given token precision. */
export function warThreshold(decimals: TokenDecimals): BaseUnits {
  return parseDecimalToBaseUnits(GENESIS_WAR_THRESHOLD_DECIMAL, decimals);
}

// ---------------------------------------------------------------------------
// Request lifecycle (§47.4, §76.1)
// ---------------------------------------------------------------------------

export interface GenesisRequest {
  readonly requestId: string;
  readonly wallet: WalletAddress;
  readonly state: GenesisRequestState;
  /**
   * The block whose hash will seed the result.
   *
   * §76.1: *"Once a Genesis request receives its future finalized block target,
   * neither user nor backend may select a different block because the resulting
   * rarity is undesirable."* So it is fixed when the request opens — before the
   * block exists — and never rewritten. Chosen any later, and whoever chose it
   * could already know its hash.
   */
  readonly entropyTargetBlock: number;
  readonly entropyBlockHash: string | null;
  readonly requestedAt: UtcTimestamp;
  readonly committedAt: UtcTimestamp | null;
}

/**
 * The one request id a wallet will ever have.
 *
 * §6 grants one Genesis card per wallet forever, and the request id is part of
 * the seed (§9). An id derived from the wallet leaves nothing to re-issue: a
 * second request for the same wallet is the same request, with the same target
 * block and so the same card, and the database's primary key refuses anything
 * else. A random id per attempt would make every retry a chance to reroll.
 */
export function genesisRequestId(wallet: WalletAddress): string {
  return `genesis-${wallet}`;
}

/**
 * Opens a request bound to a future block.
 *
 * @param targetBlock A block number the chain has not produced yet (§9). The
 *   caller picks it from the chain head; this refuses anything that is not a
 *   positive safe integer.
 */
export function openRequest(
  requestId: string,
  wallet: WalletAddress,
  targetBlock: number,
  at: UtcTimestamp,
): GenesisRequest {
  if (requestId.length === 0) {
    throw new RangeError('Genesis request id must not be empty');
  }
  if (!Number.isSafeInteger(targetBlock) || targetBlock <= 0) {
    throw new RangeError('Entropy target block must be a positive integer');
  }
  return {
    requestId,
    wallet,
    state: 'PENDING',
    entropyTargetBlock: targetBlock,
    entropyBlockHash: null,
    requestedAt: at,
    committedAt: null,
  };
}

/**
 * Commits the hash of the request's own target block, once it is finalized.
 *
 * @throws Error if the request is not `PENDING`, already has a hash, or the
 *   block is not its target. §76.1 forbids another block, and the surest way to
 *   enforce that is to accept no other.
 */
export function commitEntropy(
  request: GenesisRequest,
  block: { readonly number: number; readonly hash: string },
  at: UtcTimestamp,
): GenesisRequest {
  if (!canTransitionGenesisRequest(request.state, 'COMMITTED')) {
    throw new Error(`Cannot commit entropy for a request in state ${request.state}`);
  }
  if (request.entropyBlockHash !== null) {
    throw new Error(
      `Request ${request.requestId} already has entropy; §76.1 forbids selecting another`,
    );
  }
  if (block.number !== request.entropyTargetBlock) {
    throw new Error(
      `Request ${request.requestId} is bound to block ${String(request.entropyTargetBlock)}, ` +
        `not ${String(block.number)}; §76.1 forbids selecting another`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    throw new RangeError('Entropy block hash must be a 32-byte hex hash');
  }
  return {
    ...request,
    state: 'COMMITTED',
    entropyBlockHash: block.hash.toLowerCase(),
    committedAt: at,
  };
}

// ---------------------------------------------------------------------------
// Resolution and the reveal gate (§8.4, §76.5)
// ---------------------------------------------------------------------------

/** A resolved but not yet revealable outcome. */
export interface ResolvedGenesis {
  readonly request: GenesisRequest;
  readonly outcome: GenesisOutcome;
  readonly initialUses: number;
}

/**
 * Resolves a committed request.
 *
 * `secretAvailable` must be the coverage read **at this moment**, not one cached
 * from when the request opened: §8.4 re-checks coverage inside the reservation
 * lock, and a stale reading is exactly how a Secret gets promised that the vault
 * cannot pay.
 */
export function resolveRequest(request: GenesisRequest, secretAvailable: boolean): ResolvedGenesis {
  if (request.state !== 'COMMITTED') {
    throw new Error(`Cannot resolve a request in state ${request.state}`);
  }
  if (request.entropyBlockHash === null) {
    throw new Error(`Request ${request.requestId} has no committed entropy`);
  }

  const outcome = resolveGenesis(
    {
      finalizedBlockHash: request.entropyBlockHash,
      wallet: request.wallet,
      requestId: request.requestId,
    },
    secretAvailable,
  );

  return { request, outcome, initialUses: initialUsesFor(outcome.cardType) };
}

/** Proof that a Secret reward was set aside before anyone was told about it. */
export interface SecretReservation {
  readonly entitlementId: string;
  readonly amount: BaseUnits;
  /** Transaction reference §76.5 requires to be committed before the reveal. */
  readonly reservationTx: string;
}

/**
 * A result that has passed every gate and may be shown to the user.
 *
 * Only `finalizeGenesis` produces one, and it is the only value a reveal
 * endpoint should accept. Making that a type rather than a convention is what
 * stops a future caller from rendering a resolved-but-unreserved Secret.
 */
export interface RevealableGenesis {
  readonly wallet: WalletAddress;
  readonly requestId: string;
  readonly rarity: Rarity;
  readonly cardType: GenesisOutcome['cardType'];
  readonly initialUses: number;
  readonly slot: number;
  readonly seed: string;
  /** Whether Secret was reachable when this was resolved (§8.3); part of the evidence. */
  readonly secretAvailable: boolean;
  readonly rarityTableVersion: string;
  /** Present exactly when the rarity is `SECRET`. */
  readonly secretReservation: SecretReservation | null;
  readonly finalizedAt: UtcTimestamp;
}

export type FinalizeOutcome =
  | {
      readonly kind: 'REVEALABLE';
      readonly result: RevealableGenesis;
      readonly request: GenesisRequest;
    }
  /**
   * Reservation did not complete. §76.5: the service must not show a false
   * Secret success. The request stays `COMMITTED` so recovery can retry the
   * reservation — reissuing it would be the reroll §9 forbids.
   */
  | {
      readonly kind: 'RESERVATION_FAILED';
      readonly request: GenesisRequest;
      readonly reason: string;
    };

/**
 * Completes a resolved request, enforcing the §8.4 ordering.
 *
 * A non-Secret result needs no reservation and finalizes directly. A Secret
 * needs `reservation` present; without it this returns `RESERVATION_FAILED` and
 * produces nothing revealable.
 *
 * @throws RangeError if a reservation is supplied for a non-Secret result. That
 *   would mean SPY was set aside for a card that grants none, and the vault
 *   would slowly leak coverage to winners who were never owed it.
 */
export function finalizeGenesis(
  resolved: ResolvedGenesis,
  at: UtcTimestamp,
  reservation: SecretReservation | null,
): FinalizeOutcome {
  const isSecret = resolved.outcome.rarity === 'SECRET';

  if (!isSecret && reservation !== null) {
    throw new RangeError(
      'A reservation was supplied for a non-Secret result; only SECRET grants a reward (§8.1)',
    );
  }

  if (isSecret && reservation === null) {
    return {
      kind: 'RESERVATION_FAILED',
      request: resolved.request,
      reason: 'Secret reservation did not complete; nothing is revealed (§76.5)',
    };
  }

  return {
    kind: 'REVEALABLE',
    request: { ...resolved.request, state: 'FINALIZED' },
    result: {
      wallet: resolved.request.wallet,
      requestId: resolved.request.requestId,
      rarity: resolved.outcome.rarity,
      cardType: resolved.outcome.cardType,
      initialUses: resolved.initialUses,
      slot: resolved.outcome.slot,
      seed: resolved.outcome.seed,
      secretAvailable: resolved.outcome.secretAvailable,
      rarityTableVersion: resolved.outcome.rarityTableVersion,
      secretReservation: reservation,
      finalizedAt: at,
    },
  };
}

/** One claim per wallet, forever (§6). Re-exported so callers need one import. */
export { GENESIS_CLAIMS_PER_WALLET };
