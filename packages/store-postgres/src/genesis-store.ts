import type {
  GenesisClaim,
  GenesisRepository,
  GenesisRequest,
  RevealableGenesis,
  StoredGenesis,
} from '@ponswars/genesis-service';
import {
  CARD_TYPES,
  GENESIS_REQUEST_STATES,
  RARITIES,
  utcTimestamp,
  walletAddress,
  type CardType,
  type GenesisRequestState,
  type Rarity,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import type { SqlDatabase, SqlExecutor, SqlRow } from './sql.js';

/**
 * Genesis requests, claims and the cards they deal, in PostgreSQL (§49.3, §49.4).
 *
 * The tables hold the rules that matter most here, so this adapter leans on
 * them rather than restating them: one request per wallet (its id is derived
 * from the wallet), a target block from the moment the request is written, one
 * claim per wallet and per request, and claims nobody can update (0012).
 *
 * Recording a card is one transaction — the request finalized, the claim, the
 * card with its charges, and the wallet marked as having claimed — so a card
 * never exists without the claim that explains it, nor a claim without its card.
 */
export class PostgresGenesisStore implements GenesisRepository {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  find(wallet: WalletAddress): Promise<StoredGenesis | null> {
    return readStored(this.#db, wallet);
  }

  open(request: GenesisRequest): Promise<GenesisRequest> {
    return this.#db.transaction(async (tx) => {
      await tx.query('INSERT INTO wallet_profiles (wallet) VALUES ($1) ON CONFLICT DO NOTHING', [
        request.wallet,
      ]);
      // A request that already exists wins, target block and all (§76.1): the
      // conflict leaves it untouched, and what is read back is that row.
      await tx.query(
        `INSERT INTO genesis_requests (request_id, wallet, state, entropy_target_block, requested_at)
         VALUES ($1, $2, 'PENDING', $3, $4)
         ON CONFLICT DO NOTHING`,
        [request.requestId, request.wallet, request.entropyTargetBlock, iso(request.requestedAt)],
      );
      const stored = await readStored(tx, request.wallet);
      if (stored === null) {
        throw new Error(`Genesis request for ${request.wallet} was neither written nor found`);
      }
      return stored.request;
    });
  }

  async commit(request: GenesisRequest): Promise<void> {
    if (request.entropyBlockHash === null || request.committedAt === null) {
      throw new Error('Only a request with committed entropy can be committed');
    }
    const { rows } = await this.#db.query(
      `UPDATE genesis_requests
          SET state = 'COMMITTED', entropy_block_hash = $2, committed_at = $3, updated_at = now()
        WHERE request_id = $1 AND state = 'PENDING' AND entropy_target_block = $4
        RETURNING request_id`,
      [
        request.requestId,
        request.entropyBlockHash,
        iso(request.committedAt),
        request.entropyTargetBlock,
      ],
    );
    if (rows.length === 0) {
      throw new Error(`Genesis request ${request.requestId} is not pending on its target block`);
    }
  }

  record(request: GenesisRequest, result: RevealableGenesis): Promise<GenesisClaim> {
    return this.#db.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT state, entropy_target_block, entropy_block_hash
           FROM genesis_requests WHERE request_id = $1 FOR UPDATE`,
        [request.requestId],
      );
      const row = locked.rows[0];
      if (row === undefined) {
        throw new Error(`No Genesis request ${request.requestId}`);
      }

      const existing = await readStored(tx, request.wallet);
      if (existing !== null && existing.claim !== null) {
        // Recorded by an earlier call. The result is a pure function of the
        // committed inputs, so the first write is the same card.
        return existing.claim;
      }

      if (request.entropyBlockHash === null) {
        throw new Error('A claim needs committed entropy');
      }
      if (Number(row['entropy_target_block']) !== request.entropyTargetBlock) {
        throw new Error(`Genesis request ${request.requestId} is bound to another block`);
      }
      const storedHash = row['entropy_block_hash'];
      if (storedHash !== null && storedHash !== request.entropyBlockHash) {
        throw new Error(`Genesis request ${request.requestId} committed another block hash`);
      }

      await tx.query(
        `UPDATE genesis_requests
            SET state = 'FINALIZED', entropy_block_hash = $2,
                committed_at = COALESCE(committed_at, $3), updated_at = now()
          WHERE request_id = $1`,
        [
          request.requestId,
          request.entropyBlockHash,
          iso(request.committedAt ?? result.finalizedAt),
        ],
      );
      const numbered = await tx.query(
        "SELECT lpad(nextval('genesis_number_seq')::text, 6, '0') AS genesis_id",
      );
      const genesisId = text(numbered.rows[0]?.['genesis_id']);
      await tx.query(
        `INSERT INTO genesis_claims (
           genesis_id, wallet, request_id, seed, slot, secret_available, rarity, card,
           initial_uses, rng_version, finalized_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          genesisId,
          result.wallet,
          result.requestId,
          result.seed,
          result.slot,
          result.secretAvailable,
          result.rarity,
          result.cardType,
          result.initialUses,
          result.rarityTableVersion,
          iso(result.finalizedAt),
        ],
      );
      await tx.query(
        `INSERT INTO cards (card_instance_id, wallet, genesis_id, rarity, card, initial_uses, remaining_uses)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [
          `card-${genesisId}`,
          result.wallet,
          genesisId,
          result.rarity,
          result.cardType,
          result.initialUses,
        ],
      );
      // §8.4: a Secret is recorded only with its reservation, and the
      // entitlement row is written in the same transaction as the claim — its
      // existence is what proves the reveal was allowed (0006).
      if (result.secretReservation !== null) {
        await tx.query(
          `INSERT INTO secret_entitlements (entitlement_id, genesis_id, wallet, amount, reservation_tx)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            result.secretReservation.entitlementId,
            genesisId,
            result.wallet,
            result.secretReservation.amount.toString(),
            result.secretReservation.reservationTx,
          ],
        );
      }
      await tx.query(
        'UPDATE wallet_profiles SET genesis_claimed = TRUE, updated_at = now() WHERE wallet = $1',
        [result.wallet],
      );

      const recorded = await readStored(tx, request.wallet);
      if (recorded?.claim == null) {
        throw new Error(`Genesis claim for ${request.wallet} was written and not found`);
      }
      return recorded.claim;
    });
  }
}

async function readStored(db: SqlExecutor, wallet: WalletAddress): Promise<StoredGenesis | null> {
  const { rows } = await db.query(
    `SELECT r.request_id, r.wallet, r.state, r.entropy_target_block, r.entropy_block_hash,
            r.requested_at, r.committed_at,
            c.genesis_id, c.seed, c.slot, c.secret_available, c.rarity, c.card, c.initial_uses,
            c.rng_version, c.finalized_at, k.card_instance_id, s.reservation_tx
       FROM genesis_requests r
       LEFT JOIN genesis_claims c ON c.request_id = r.request_id
       LEFT JOIN cards k ON k.genesis_id = c.genesis_id
       LEFT JOIN secret_entitlements s ON s.genesis_id = c.genesis_id
      WHERE r.wallet = $1
      ORDER BY r.requested_at DESC
      LIMIT 1`,
    [wallet],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const request: GenesisRequest = {
    requestId: text(row['request_id']),
    wallet: walletAddress(text(row['wallet'])),
    state: requestState(row['state']),
    entropyTargetBlock: Number(row['entropy_target_block']),
    entropyBlockHash: row['entropy_block_hash'] === null ? null : text(row['entropy_block_hash']),
    requestedAt: instant(row['requested_at']),
    committedAt: row['committed_at'] === null ? null : instant(row['committed_at']),
  };
  return { request, claim: row['genesis_id'] === null ? null : claimOf(row, request) };
}

function claimOf(row: SqlRow, request: GenesisRequest): GenesisClaim {
  if (request.entropyBlockHash === null) {
    throw new Error(`Genesis claim ${text(row['genesis_id'])} has no committed entropy`);
  }
  return {
    genesisId: text(row['genesis_id']),
    cardInstanceId: text(row['card_instance_id']),
    wallet: request.wallet,
    requestId: request.requestId,
    entropyBlock: request.entropyTargetBlock,
    entropyBlockHash: request.entropyBlockHash,
    rarity: rarity(row['rarity']),
    cardType: cardType(row['card']),
    initialUses: Number(row['initial_uses']),
    slot: Number(row['slot']),
    seed: text(row['seed']),
    secretAvailable: row['secret_available'] === true,
    rarityTableVersion: text(row['rng_version']),
    secretReservationTx: row['reservation_tx'] == null ? null : text(row['reservation_tx']),
    finalizedAt: instant(row['finalized_at']),
  };
}

function requestState(value: unknown): GenesisRequestState {
  const found = GENESIS_REQUEST_STATES.find((state) => state === value);
  if (found === undefined) {
    throw new TypeError(`Unknown Genesis request state ${String(value)}`);
  }
  return found;
}

function rarity(value: unknown): Rarity {
  const found = RARITIES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new TypeError(`Unknown rarity ${String(value)}`);
  }
  return found;
}

function cardType(value: unknown): CardType {
  const found = CARD_TYPES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new TypeError(`Stored card ${String(value)} is not in the card catalog`);
  }
  return found;
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected text, got ${typeof value}`);
  }
  return value;
}

function instant(value: unknown): UtcTimestamp {
  return utcTimestamp(value instanceof Date ? value.getTime() : new Date(String(value)).getTime());
}

function iso(at: UtcTimestamp): string {
  return new Date(at).toISOString();
}
