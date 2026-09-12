import type { CardHolding, CardHoldings } from '@ponswars/round-service';
import type { WalletAddress } from '@ponswars/shared-types';
import type { SqlExecutor } from './sql.js';

/**
 * A wallet's Genesis card, from the `cards` table (§6, §49.4).
 *
 * The table is the record: a card is there once its Genesis claim has been
 * recorded, with its charges counted by `card_usage_ledger`. A wallet with no
 * row holds no card this server can let it deploy — which, until something
 * records claims from the chain, is every wallet. That is the safe answer
 * rather than a limitation: a card nobody verified would earn support and a
 * card assist exactly like a real one.
 */
export class PostgresCardHoldings implements CardHoldings {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  async cardOf(wallet: WalletAddress): Promise<CardHolding | null> {
    const { rows } = await this.#db.query(
      'SELECT card_instance_id, remaining_uses FROM cards WHERE wallet = $1',
      [wallet],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          cardInstanceId: String(row['card_instance_id']),
          remainingUses: Number(row['remaining_uses']),
        };
  }
}
