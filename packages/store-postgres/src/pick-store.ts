import type { LockedPick } from '@ponswars/battle-engine';
import { PicksLockedError, type PickRepository, type SubmittedPick } from '@ponswars/round-service';
import {
  battleId,
  clientRequestId,
  isActiveTicker,
  roundId as toRoundId,
  utcTimestamp,
  walletAddress,
  type ActiveTicker,
  type CardDecision,
  type RoundId,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import type { SqlDatabase, SqlExecutor, SqlRow } from './sql.js';

/**
 * Picks in PostgreSQL (§4.2, §22, §47.5, §49.8).
 *
 * Three properties live here rather than in the API, because only the database
 * can hold them for every process at once:
 *
 * - **one pick per wallet per round** is `player_picks`' primary key;
 * - **a retried request is a replay** — every key a wallet has used in a round
 *   is in `pick_requests`, so a late retry of a superseded request answers with
 *   what it stored instead of overwriting the decision that replaced it (§66.6);
 * - **nothing changes after lock** — `lockedPicks` sets `rounds.picks_locked_at`
 *   in the transaction that reads the frozen set, and every write checks it.
 *
 * The last one needs a lock, not just a check. A write that read "not locked"
 * and then committed after the frozen set was read would be a pick the engine
 * never saw. So each write holds a shared advisory lock on its round for the
 * length of its transaction, and reading the frozen set takes the exclusive one:
 * the two cannot interleave, and whichever comes second sees the first.
 */
export class PostgresPickStore implements PickRepository {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  submit(
    pick: SubmittedPick,
  ): Promise<{ readonly stored: SubmittedPick; readonly replayed: boolean }> {
    return this.#db.transaction(async (tx) => {
      await openForWrites(tx, pick.roundId, pick.wallet);

      const { rows: seen } = await tx.query(
        `SELECT battle_id, backed_ticker, card_decision, received_at
           FROM pick_requests
          WHERE wallet = $1 AND round_id = $2 AND client_request_id = $3`,
        [pick.wallet, pick.roundId, pick.clientRequestId],
      );
      const replay = seen[0];
      if (replay !== undefined) {
        return {
          stored: {
            wallet: pick.wallet,
            roundId: pick.roundId,
            clientRequestId: pick.clientRequestId,
            battleId: battleId(text(replay['battle_id'])),
            backedTicker: ticker(replay['backed_ticker']),
            cardDecision: decision(replay['card_decision']),
            receivedAt: instant(replay['received_at']),
          },
          replayed: true,
        };
      }

      await tx.query(
        `INSERT INTO wallet_profiles (wallet, last_seen_at)
         VALUES ($1, now())
         ON CONFLICT (wallet) DO UPDATE SET last_seen_at = now()`,
        [pick.wallet],
      );
      await tx.query(
        `INSERT INTO player_picks (
           wallet, round_id, battle_id, backed_ticker, card_decision,
           client_request_id, received_at, committed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (wallet, round_id) DO UPDATE SET
           battle_id = EXCLUDED.battle_id,
           backed_ticker = EXCLUDED.backed_ticker,
           card_decision = EXCLUDED.card_decision,
           client_request_id = EXCLUDED.client_request_id,
           received_at = EXCLUDED.received_at,
           committed_at = now(),
           revision = player_picks.revision + 1,
           updated_at = now()`,
        [
          pick.wallet,
          pick.roundId,
          pick.battleId,
          pick.backedTicker,
          pick.cardDecision,
          pick.clientRequestId,
          iso(pick.receivedAt),
        ],
      );
      await tx.query(
        `INSERT INTO pick_requests (
           wallet, round_id, client_request_id, battle_id, backed_ticker, card_decision, received_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          pick.wallet,
          pick.roundId,
          pick.clientRequestId,
          pick.battleId,
          pick.backedTicker,
          pick.cardDecision,
          iso(pick.receivedAt),
        ],
      );

      return { stored: pick, replayed: false };
    });
  }

  async find(roundId: RoundId, wallet: WalletAddress): Promise<SubmittedPick | null> {
    const { rows } = await this.#db.query(
      `SELECT ${PICK_COLUMNS} FROM player_picks WHERE wallet = $1 AND round_id = $2`,
      [wallet, roundId],
    );
    const row = rows[0];
    return row === undefined ? null : pickFrom(row);
  }

  lockedPicks(roundId: RoundId): Promise<readonly LockedPick[]> {
    return this.#db.transaction(async (tx) => {
      // Exclusive: no write to this round can be part-way through while the set
      // is frozen, and none can start until it has been.
      await tx.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [ROUND_LOCK, roundId]);

      // Idempotent. A loop that restarts at lock reads the same frozen set and
      // keeps the instant it was first frozen at.
      await tx.query(
        `UPDATE rounds SET picks_locked_at = COALESCE(picks_locked_at, now()) WHERE round_id = $1`,
        [roundId],
      );
      await tx.query(
        `UPDATE player_picks
            SET locked_at = now(),
                locked_battle_id = battle_id,
                locked_ticker = backed_ticker,
                locked_card_decision = card_decision,
                updated_at = now()
          WHERE round_id = $1 AND locked_at IS NULL`,
        [roundId],
      );
      await deployCards(tx, roundId);

      // What was locked, not what the row says now — after this they are the
      // same, and the locked columns are the ones that cannot change. Ordered
      // byte-wise by wallet so the engine receives them in one order however
      // the database is collated.
      const { rows } = await tx.query(
        `SELECT wallet, locked_battle_id, locked_ticker, locked_card_decision
           FROM player_picks
          WHERE round_id = $1 AND locked_at IS NOT NULL
          ORDER BY wallet COLLATE "C"`,
        [roundId],
      );
      return rows.map((row) => ({
        wallet: walletAddress(text(row['wallet'])),
        battleId: battleId(text(row['locked_battle_id'])),
        backedTicker: ticker(row['locked_ticker']),
        cardDeployed: decision(row['locked_card_decision']) === 'USE',
      }));
    });
  }

  withdraw(roundId: RoundId, wallet: WalletAddress): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      await openForWrites(tx, roundId, wallet);

      const { rows } = await tx.query(
        `DELETE FROM player_picks WHERE wallet = $1 AND round_id = $2 RETURNING client_request_id`,
        [wallet, roundId],
      );
      const removed = rows[0];
      if (removed === undefined) {
        return false;
      }
      // The withdrawn request's key goes with it: picking the same thing again
      // is a new decision, and holding the key would answer it with the pick
      // that was just withdrawn.
      await tx.query(
        `DELETE FROM pick_requests WHERE wallet = $1 AND round_id = $2 AND client_request_id = $3`,
        [wallet, roundId, text(removed['client_request_id'])],
      );
      return true;
    });
  }

  decideCard(
    roundId: RoundId,
    wallet: WalletAddress,
    cardDecision: CardDecision,
    at: UtcTimestamp,
  ): Promise<SubmittedPick | null> {
    return this.#db.transaction(async (tx) => {
      await openForWrites(tx, roundId, wallet);

      const { rows } = await tx.query(
        `UPDATE player_picks
            SET card_decision = $3,
                received_at = $4,
                committed_at = now(),
                revision = revision + 1,
                updated_at = now()
          WHERE wallet = $1 AND round_id = $2
          RETURNING ${PICK_COLUMNS}`,
        [wallet, roundId, cardDecision, iso(at)],
      );
      const row = rows[0];
      return row === undefined ? null : pickFrom(row);
    });
  }

  async count(roundId: RoundId): Promise<number> {
    const { rows } = await this.#db.query(
      `SELECT count(*)::int AS picks FROM player_picks WHERE round_id = $1`,
      [roundId],
    );
    return Number(rows[0]?.['picks'] ?? 0);
  }
}

/**
 * Deploys the round's armed cards, spending one charge each (§3.2, §40.7).
 *
 * Inside the exclusive round lock, in three steps whose order is the point:
 *
 * 1. An armed card the wallet cannot spend — no card on record, or no charge
 *    left — is locked as saved. The API refuses to arm one, but this is the
 *    frozen set the engine scores, and a card that is not there must not reach
 *    it by any route: the engine would credit it with support and a card assist
 *    like a real one.
 * 2. Every remaining armed card is recorded as deployed in the usage ledger.
 *    The ledger allows one deployment per wallet per round, so a lock read again
 *    after a restart records nothing new.
 * 3. Only the cards step 2 actually recorded lose a charge — which is what makes
 *    spending exactly-once rather than once per attempt.
 */
async function deployCards(tx: SqlExecutor, roundId: RoundId): Promise<void> {
  await tx.query(
    `UPDATE player_picks p
        SET locked_card_decision = 'SAVE', updated_at = now()
      WHERE p.round_id = $1
        AND p.locked_card_decision = 'USE'
        AND NOT EXISTS (
          SELECT 1 FROM card_usage_ledger l
           WHERE l.wallet = p.wallet AND l.round_id = p.round_id AND l.event = 'DEPLOY'
        )
        AND NOT EXISTS (
          SELECT 1 FROM cards c WHERE c.wallet = p.wallet AND c.remaining_uses > 0
        )`,
    [roundId],
  );

  const { rows } = await tx.query(
    `INSERT INTO card_usage_ledger (card_instance_id, wallet, round_id, battle_id, event, delta)
     SELECT c.card_instance_id, p.wallet, p.round_id, p.locked_battle_id, 'DEPLOY', -1
       FROM player_picks p
       JOIN cards c ON c.wallet = p.wallet
      WHERE p.round_id = $1 AND p.locked_card_decision = 'USE'
     ON CONFLICT DO NOTHING
     RETURNING card_instance_id`,
    [roundId],
  );

  for (const row of rows) {
    // `depleted_at` is set in the same statement that spends the last charge;
    // the table requires the two to agree.
    await tx.query(
      `UPDATE cards
          SET remaining_uses = remaining_uses - 1,
              depleted_at = CASE WHEN remaining_uses = 1 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE card_instance_id = $1`,
      [text(row['card_instance_id'])],
    );
  }
}

/** Advisory lock namespaces, so these locks cannot collide with anyone else's. */
const ROUND_LOCK = 721_204_610;
const WALLET_LOCK = 721_204_611;

const PICK_COLUMNS =
  'wallet, round_id, battle_id, backed_ticker, card_decision, received_at, client_request_id';

/**
 * Takes the locks a pick write needs, and refuses one to a frozen round.
 *
 * Shared on the round, so writes from different wallets run side by side and
 * all of them wait for a freeze in progress. Exclusive on the wallet in that
 * round, so two requests from one wallet — two tabs, or a retry racing its
 * original — are applied one after the other and the second sees the first.
 * Always in that order, round then wallet, so no two writes can deadlock.
 */
async function openForWrites(
  tx: SqlExecutor,
  roundId: RoundId,
  wallet: WalletAddress,
): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock_shared($1, hashtext($2))`, [ROUND_LOCK, roundId]);
  await tx.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [
    WALLET_LOCK,
    `${roundId}|${wallet}`,
  ]);

  const { rows } = await tx.query(`SELECT picks_locked_at FROM rounds WHERE round_id = $1`, [
    roundId,
  ]);
  // A round with no row is not open for picks either — the optional chain reads
  // it as `undefined`, which is not `null`. Nothing can be locked against a
  // round that was never stored, and the foreign key would refuse the pick
  // anyway, less clearly.
  if (rows[0]?.['picks_locked_at'] !== null) {
    throw new PicksLockedError(roundId);
  }
}

function pickFrom(row: SqlRow): SubmittedPick {
  return {
    wallet: walletAddress(text(row['wallet'])),
    roundId: toRoundId(text(row['round_id'])),
    battleId: battleId(text(row['battle_id'])),
    backedTicker: ticker(row['backed_ticker']),
    cardDecision: decision(row['card_decision']),
    receivedAt: instant(row['received_at']),
    clientRequestId: clientRequestId(text(row['client_request_id'])),
  };
}

/**
 * A ticker read back from a row, checked.
 *
 * The column is `TEXT`, and the roster is §4.1's to decide rather than the
 * schema's. A value outside it is a row something else wrote, and it is refused
 * here rather than handed to the engine as a side of a battle.
 */
function ticker(value: unknown): ActiveTicker {
  const read = text(value);
  if (!isActiveTicker(read)) {
    throw new TypeError(`Stored pick backs ${read}, which is not an active ticker`);
  }
  return read;
}

function decision(value: unknown): CardDecision {
  const read = text(value);
  if (read !== 'USE' && read !== 'SAVE') {
    throw new TypeError(`Stored card decision ${read} is neither USE nor SAVE`);
  }
  return read;
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new TypeError(`Expected a text column, got ${typeof value}`);
}

function instant(value: unknown): UtcTimestamp {
  return utcTimestamp(value instanceof Date ? value.getTime() : new Date(String(value)).getTime());
}

function iso(at: UtcTimestamp): string {
  return new Date(at).toISOString();
}
