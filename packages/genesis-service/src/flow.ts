import {
  type BaseUnits,
  type CardType,
  type Rarity,
  type TokenDecimals,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import {
  checkEligibility,
  commitEntropy,
  finalizeGenesis,
  genesisRequestId,
  openRequest,
  resolveRequest,
  warThreshold,
  type GenesisRequest,
  type ResolvedGenesis,
  type RevealableGenesis,
  type SecretReservation,
} from './genesis-service.js';

/**
 * A Genesis claim from request to card (§6, §9, §27.2, §68.3, §69.6).
 *
 * The domain functions beside this decide each step; this runs them in order
 * against the three things that outlive a request — the database, the chain and
 * the `$WAR` token — and says where a wallet has got to.
 *
 * 1. A wallet asks. It must hold at least 1,000,000 `$WAR` **now** and never
 *    have claimed (§6). Its one request is written, bound to a block a few past
 *    the chain head — a block that does not exist yet (§9, §76.1).
 * 2. Nothing happens until that block is finalized. Asked in the meantime, the
 *    answer is `PENDING_FINALITY`.
 * 3. Once it is, the hash seeds the card (§9), the claim and its card are
 *    written in one transaction, and the answer is `READY`.
 *
 * Step 3 happens on whichever call first finds the block finalized. There is no
 * worker to fall behind: the result is a pure function of the committed inputs,
 * so two calls racing to it compute the same card, and the repository keeps the
 * first write.
 */

/** A card a wallet was dealt, as recorded (§49.3, §49.4). */
export interface GenesisClaim {
  /** The Genesis number, e.g. `000042`, in the order claims were recorded. */
  readonly genesisId: string;
  readonly cardInstanceId: string;
  readonly wallet: WalletAddress;
  readonly requestId: string;
  readonly entropyBlock: number;
  readonly entropyBlockHash: string;
  readonly rarity: Rarity;
  readonly cardType: CardType;
  readonly initialUses: number;
  readonly slot: number;
  readonly seed: string;
  readonly secretAvailable: boolean;
  readonly rarityTableVersion: string;
  /**
   * The vault transaction that reserved a Secret's reward (§76.5), present
   * exactly when the card is a Secret.
   */
  readonly secretReservationTx: string | null;
  readonly finalizedAt: UtcTimestamp;
}

export interface StoredGenesis {
  readonly request: GenesisRequest;
  readonly claim: GenesisClaim | null;
}

/** Where requests and claims are kept. */
export interface GenesisRepository {
  /** The wallet's request, and its claim once there is one. */
  find(wallet: WalletAddress): Promise<StoredGenesis | null>;
  /**
   * Writes a new request — or, when the wallet already has one, returns that
   * one unchanged. The first target block stands (§76.1).
   */
  open(request: GenesisRequest): Promise<GenesisRequest>;
  /** Persists a committed hash, for a result that cannot be revealed yet. */
  commit(request: GenesisRequest): Promise<void>;
  /**
   * Records a revealable result: the request finalized, the claim, the card.
   * All or nothing, and once — a second call returns the first claim.
   */
  record(request: GenesisRequest, result: RevealableGenesis): Promise<GenesisClaim>;
}

/** The chain, for the two things Genesis entropy needs from it. */
export interface GenesisChain {
  /** The newest block number the chain has produced. */
  headBlock(): Promise<number>;
  /** Block `number` once it is finalized, or `null` while it is not. */
  finalizedBlock(
    number: number,
  ): Promise<{ readonly number: number; readonly hash: string } | null>;
}

/**
 * The Secret Stock Vault, for the two things a Secret reveal needs (§8.3, §8.4).
 *
 * `reserve` sets the reward aside for one wallet on chain. It answers
 * `UNCOVERED` when the vault no longer holds a reward's worth — a designed
 * state, not a fault — and throws for anything else, which the flow treats as
 * try again. It is idempotent per wallet: a reservation already on chain for
 * that wallet is returned rather than refused, so a crash between the
 * transaction and the database costs nothing.
 */
export interface SecretVault {
  isCovered(): Promise<boolean>;
  reserve(
    wallet: WalletAddress,
  ): Promise<
    | { readonly kind: 'RESERVED'; readonly reservation: SecretReservation }
    | { readonly kind: 'UNCOVERED' }
  >;
}

export type GenesisStatus =
  /** This wallet has never asked. */
  | { readonly kind: 'NONE' }
  /** §6: under 1,000,000 `$WAR` right now. Nothing was written. */
  | {
      readonly kind: 'NOT_ELIGIBLE_BALANCE';
      readonly balance: BaseUnits;
      readonly threshold: BaseUnits;
      readonly decimals: TokenDecimals;
    }
  /** Bound to a block that is not finalized yet. */
  | {
      readonly kind: 'PENDING_FINALITY';
      readonly requestId: string;
      readonly targetBlock: number;
    }
  /** §76.5: the card is a Secret and its reward is not reserved yet; nothing is shown. */
  | { readonly kind: 'SECRET_RESERVATION_PENDING'; readonly requestId: string }
  /** The card, ready to reveal. */
  | { readonly kind: 'READY'; readonly claim: GenesisClaim }
  /** A request that found the wallet had already claimed (§6). */
  | { readonly kind: 'ALREADY_CLAIMED'; readonly claim: GenesisClaim };

/**
 * How far past the chain head a request's block is.
 *
 * Far enough that the block cannot already exist when the request is written,
 * even if the head read was a moment stale. Robinhood Chain seals several
 * blocks a second, so ten is a second or two. Not an `OPEN` value (§102): any
 * future block gives the same guarantee, and this only moves how soon it comes.
 */
export const ENTROPY_TARGET_DISTANCE = 10;

export interface GenesisFlowDeps {
  readonly repository: GenesisRepository;
  readonly chain: GenesisChain;
  /** The wallet's `$WAR`, in base units, read now (§6, §68.2). */
  readonly warBalanceOf: (wallet: WalletAddress) => Promise<BaseUnits>;
  readonly warDecimals: TokenDecimals;
  /**
   * The vault this service reserves Secret rewards in, or `null` when it holds
   * no key that can. Without one, Secret is unavailable (§8.3): its band deals
   * Legendary, and the rarity table records that it did.
   */
  readonly secretVault: SecretVault | null;
  readonly now: () => UtcTimestamp;
}

/**
 * A read from Robinhood Chain failed, so nothing was decided.
 *
 * Its own error so a caller can tell a chain that did not answer — try again,
 * nothing was written — from a fault in the flow or the database.
 */
export class GenesisChainError extends Error {
  constructor(cause: unknown) {
    super(
      `Robinhood Chain did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'GenesisChainError';
  }
}

async function fromChain<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    throw new GenesisChainError(error);
  }
}

export class GenesisFlow {
  readonly #deps: GenesisFlowDeps;

  constructor(deps: GenesisFlowDeps) {
    this.#deps = deps;
  }

  /**
   * The card this wallet was dealt, or `null` — from the record alone.
   *
   * No chain read and nothing finished: for a page that shows a card beside
   * other things (a profile), where a pending claim is not this page's to move.
   */
  async claimOf(wallet: WalletAddress): Promise<GenesisClaim | null> {
    return (await this.#deps.repository.find(wallet))?.claim ?? null;
  }

  /** Where this wallet's claim has got to, finishing it if its block is now final. */
  async status(wallet: WalletAddress): Promise<GenesisStatus> {
    const stored = await this.#deps.repository.find(wallet);
    if (stored === null) {
      return { kind: 'NONE' };
    }
    return this.#advance(stored);
  }

  /**
   * Asks for this wallet's Genesis card (§69.6). Idempotent per wallet: asking
   * again returns where the first request has got to, and never opens another.
   */
  async request(wallet: WalletAddress): Promise<GenesisStatus> {
    const stored = await this.#deps.repository.find(wallet);
    if (stored !== null && stored.claim !== null) {
      return { kind: 'ALREADY_CLAIMED', claim: stored.claim };
    }
    if (stored !== null) {
      return this.#advance(stored);
    }

    const balance = await fromChain(() => this.#deps.warBalanceOf(wallet));
    const verdict = checkEligibility({
      warBalance: balance,
      warDecimals: this.#deps.warDecimals,
      hasClaimedBefore: false,
    });
    if (!verdict.eligible) {
      return {
        kind: 'NOT_ELIGIBLE_BALANCE',
        balance,
        threshold: warThreshold(this.#deps.warDecimals),
        decimals: this.#deps.warDecimals,
      };
    }

    const head = await fromChain(() => this.#deps.chain.headBlock());
    const request = await this.#deps.repository.open(
      openRequest(
        genesisRequestId(wallet),
        wallet,
        head + ENTROPY_TARGET_DISTANCE,
        this.#deps.now(),
      ),
    );
    return this.#advance({ request, claim: null });
  }

  async #advance(stored: StoredGenesis): Promise<GenesisStatus> {
    if (stored.claim !== null) {
      return { kind: 'READY', claim: stored.claim };
    }

    const pending = stored.request;
    if (pending.state === 'COMMITTED') {
      // Committed and not recorded: a Secret whose reservation did not land.
      // Only a Secret is ever committed without being recorded, so it resolves
      // under the funded table again — the same slot, the same Secret — and the
      // reservation is retried (§76.5, docs/operations/secret-vault.md).
      return this.#reveal(resolveRequest(pending, true), true);
    }
    if (pending.state !== 'PENDING') {
      throw new Error(
        `Genesis request ${pending.requestId} is ${pending.state} with no claim recorded`,
      );
    }

    const block = await fromChain(() =>
      this.#deps.chain.finalizedBlock(pending.entropyTargetBlock),
    );
    if (block === null) {
      return {
        kind: 'PENDING_FINALITY',
        requestId: pending.requestId,
        targetBlock: pending.entropyTargetBlock,
      };
    }
    const request = commitEntropy(pending, block, this.#deps.now());

    // Coverage is read now, at resolution (§8.3), and never cached.
    const vault = this.#deps.secretVault;
    const secretAvailable = vault === null ? false : await fromChain(() => vault.isCovered());
    return this.#reveal(resolveRequest(request, secretAvailable), false);
  }

  /**
   * Records a resolved card — reserving a Secret's reward first (§8.4).
   *
   * - Not a Secret: recorded directly.
   * - A Secret, reserved: recorded with its reservation, and only then shown.
   * - A Secret, and the vault is out of coverage — the race §8.4 describes for
   *   the last reward: the same entropy is resolved again under the disabled
   *   table, which deals Legendary and says so on the claim.
   * - A Secret, and the reservation failed for any other reason: the commit is
   *   kept, nothing is shown, and the next read tries the reservation again.
   */
  async #reveal(resolved: ResolvedGenesis, alreadyCommitted: boolean): Promise<GenesisStatus> {
    const { request } = resolved;
    let reservation: SecretReservation | null = null;
    let card = resolved;

    if (resolved.outcome.rarity === 'SECRET') {
      const vault = this.#deps.secretVault;
      let reserved: Awaited<ReturnType<SecretVault['reserve']>> | null = null;
      if (vault !== null) {
        try {
          reserved = await vault.reserve(request.wallet);
        } catch {
          reserved = null;
        }
      }
      if (reserved === null) {
        if (!alreadyCommitted) {
          await this.#deps.repository.commit(request);
        }
        return { kind: 'SECRET_RESERVATION_PENDING', requestId: request.requestId };
      }
      if (reserved.kind === 'UNCOVERED') {
        card = resolveRequest(request, false);
      } else {
        reservation = reserved.reservation;
      }
    }

    const outcome = finalizeGenesis(card, this.#deps.now(), reservation);
    if (outcome.kind === 'RESERVATION_FAILED') {
      // Unreachable: a Secret reaches here only with its reservation. Held back
      // all the same, rather than recorded without one.
      return { kind: 'SECRET_RESERVATION_PENDING', requestId: request.requestId };
    }
    const claim = await this.#deps.repository.record(outcome.request, outcome.result);
    return { kind: 'READY', claim };
  }
}
