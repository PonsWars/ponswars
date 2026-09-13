import type { WalletAddress } from '@ponswars/shared-types';
import type { GenesisClaim, GenesisRepository, StoredGenesis } from './flow.js';
import type { GenesisRequest, RevealableGenesis } from './genesis-service.js';

/**
 * Requests and claims in memory, for tests and the local stack.
 *
 * Keeps the rules the database keeps, so a flow tested against this behaves the
 * same against PostgreSQL: one request per wallet with its first target block,
 * and a claim written once.
 */
export class MemoryGenesisRepository implements GenesisRepository {
  readonly #records = new Map<WalletAddress, StoredGenesis>();
  #nextNumber = 1;

  find(wallet: WalletAddress): Promise<StoredGenesis | null> {
    return Promise.resolve(this.#records.get(wallet) ?? null);
  }

  open(request: GenesisRequest): Promise<GenesisRequest> {
    const existing = this.#records.get(request.wallet);
    if (existing !== undefined) {
      return Promise.resolve(existing.request);
    }
    this.#records.set(request.wallet, { request, claim: null });
    return Promise.resolve(request);
  }

  commit(request: GenesisRequest): Promise<void> {
    const existing = this.#records.get(request.wallet);
    if (existing?.request.state !== 'PENDING') {
      return Promise.reject(new Error(`No pending request for ${request.wallet}`));
    }
    this.#records.set(request.wallet, { request, claim: null });
    return Promise.resolve();
  }

  record(request: GenesisRequest, result: RevealableGenesis): Promise<GenesisClaim> {
    const existing = this.#records.get(request.wallet);
    if (existing === undefined) {
      return Promise.reject(new Error(`No request for ${request.wallet}`));
    }
    if (existing.claim !== null) {
      return Promise.resolve(existing.claim);
    }
    if (request.entropyBlockHash === null) {
      return Promise.reject(new Error('A claim needs committed entropy'));
    }

    const genesisId = String(this.#nextNumber).padStart(6, '0');
    this.#nextNumber += 1;
    const claim: GenesisClaim = {
      genesisId,
      cardInstanceId: `card-${genesisId}`,
      wallet: result.wallet,
      requestId: result.requestId,
      entropyBlock: request.entropyTargetBlock,
      entropyBlockHash: request.entropyBlockHash,
      rarity: result.rarity,
      cardType: result.cardType,
      initialUses: result.initialUses,
      slot: result.slot,
      seed: result.seed,
      secretAvailable: result.secretAvailable,
      rarityTableVersion: result.rarityTableVersion,
      finalizedAt: result.finalizedAt,
    };
    this.#records.set(request.wallet, { request, claim });
    return Promise.resolve(claim);
  }
}
