import type { WalletAddress } from '@ponswars/shared-types';
import type { SqlExecutor } from './sql.js';

/**
 * Claims read back from the chain, and how far the reader has read (§17, §35.6).
 *
 * The chain decides; this records. A row exists because a `Claimed` event was
 * read, so a page can answer "was this claimed?" from the database instead of
 * an RPC call per allocation on every request — and can still answer when the
 * endpoint is having a bad minute, which is exactly when a player refreshing a
 * claim page wants an answer.
 *
 * Recording is idempotent by (distribution, wallet), which is the contract's
 * own rule: it pays a wallet once per distribution and reverts on the second
 * attempt. A reader re-reading its last window therefore writes nothing new.
 */

export interface RecordedClaim {
  readonly distributionId: bigint;
  readonly wallet: WalletAddress;
  readonly amount: bigint;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly logIndex: number;
}

export class PostgresClaimStore {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  /**
   * Records claims, ignoring ones already recorded.
   *
   * A claim with no allocation behind it is dropped rather than written. The
   * table hangs off `reward_allocations`, and a claim against a distribution
   * this deployment never calculated — another deployment's, on the same
   * contract — says nothing about this one's players.
   */
  async record(claims: readonly RecordedClaim[]): Promise<number> {
    let written = 0;
    for (const claim of claims) {
      const { rows } = await this.#db.query(
        `INSERT INTO reward_claims
           (distribution_id, wallet, amount, block_number, claim_tx, log_index)
         SELECT $1::text, $2::evm_address, $3::token_amount, $4::bigint, $5::text, $6::integer
          WHERE EXISTS (
            SELECT 1 FROM reward_allocations
             WHERE distribution_id = $1::text AND wallet = $2::evm_address
          )
         ON CONFLICT (distribution_id, wallet) DO NOTHING
         RETURNING distribution_id`,
        [
          claim.distributionId.toString(),
          claim.wallet,
          claim.amount.toString(),
          claim.blockNumber,
          claim.transactionHash.toLowerCase(),
          claim.logIndex,
        ],
      );
      written += rows.length;
    }
    return written;
  }

  /** The distributions this wallet has been recorded claiming. */
  async claimedBy(wallet: WalletAddress): Promise<ReadonlySet<string>> {
    const { rows } = await this.#db.query(
      'SELECT distribution_id FROM reward_claims WHERE wallet = $1',
      [wallet],
    );
    return new Set(rows.map((row) => String(row['distribution_id'])));
  }

  /** How far a named reader has read, or `null` if it has never recorded a position. */
  async cursor(name: string): Promise<bigint | null> {
    const { rows } = await this.#db.query(
      'SELECT block_number::text AS block_number FROM indexer_cursors WHERE name = $1',
      [name],
    );
    const row = rows[0];
    return row === undefined ? null : BigInt(String(row['block_number']));
  }

  /**
   * Moves a reader's position forward.
   *
   * Forward only. A reader that restarted mid-range re-reads rather than
   * rewinding the record of what has been read, and re-reading writes nothing
   * new — where moving the cursor back could skip a window nobody reads again.
   */
  async advance(name: string, blockNumber: bigint): Promise<void> {
    await this.#db.query(
      `INSERT INTO indexer_cursors (name, block_number) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE
         SET block_number = GREATEST(indexer_cursors.block_number, EXCLUDED.block_number),
             updated_at = now()`,
      [name, blockNumber.toString()],
    );
  }
}
