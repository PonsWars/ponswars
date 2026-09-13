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
  type RevealableGenesis,
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
   * Whether a Secret result could be revealed right now (§8.3, §8.4): the vault
   * covers a reward *and* this service can reserve it. Read at the moment a
   * result is resolved, never cached.
   */
  readonly secretAvailable: () => Promise<boolean>;
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
      // Committed and not recorded: a Secret whose reward was never reserved.
      // It is not resolved again here — the coverage it was resolved under is
      // part of its outcome (§8.3), and re-reading coverage now could turn the
      // same entropy into a different card. Recovery is an operator's (§76.5).
      return { kind: 'SECRET_RESERVATION_PENDING', requestId: pending.requestId };
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

    const resolved = resolveRequest(request, await fromChain(() => this.#deps.secretAvailable()));
    // No reservation is ever passed: nothing in this service can reserve a
    // Secret reward yet, which is why `secretAvailable` must say so and a Secret
    // is unreachable. Should one resolve anyway, the gate below holds it back.
    const outcome = finalizeGenesis(resolved, this.#deps.now(), null);
    if (outcome.kind === 'RESERVATION_FAILED') {
      await this.#deps.repository.commit(outcome.request);
      return { kind: 'SECRET_RESERVATION_PENDING', requestId: request.requestId };
    }

    const claim = await this.#deps.repository.record(outcome.request, outcome.result);
    return { kind: 'READY', claim };
  }
}
