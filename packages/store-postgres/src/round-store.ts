import {
  sectorIds,
  type RoundEngineState,
  type RoundFinalization,
  type WpAward,
} from '@ponswars/battle-engine';
import type { RoundStorePort } from '@ponswars/round-service';
import type { FinalizedBattleResult } from '@ponswars/shared-types';
import type { SqlDatabase, SqlExecutor } from './sql.js';

/**
 * The round store, in PostgreSQL (§25, §49.6–49.10).
 *
 * The in-memory store makes the loop runnable; this makes it survivable. §25
 * requires a round to resume exactly where it stopped, and a `Map` cannot
 * outlive the process it lives in.
 *
 * Two properties are worth stating.
 *
 * Everything each method writes goes in one transaction. A result stored
 * without its War Points, or War Points without their result, is a round that
 * is partly finished — and the gap between two statements is exactly where a
 * crash lands. §25's exactly-once is a promise about the pair, not about either
 * one.
 *
 * And the schema does much of the checking. `battle_results` constrains the
 * four components to sum to a hundred points and each weight to its §12 share,
 * so an adapter that mapped a column wrongly is refused by the database rather
 * than storing a result that does not add up. That is deliberate: those
 * constraints exist to catch code like this.
 */
export class PostgresRoundStore implements RoundStorePort {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Writes the round and its battles as they now stand (§22, §25).
   *
   * An upsert rather than an insert, because this is called on every state
   * transition and on every tick that changed something — the round already
   * exists after the first one. What it never does is move the clock: §23.5
   * makes those instants a property of the round, so they are written once at
   * open and left alone.
   */
  async saveState(state: RoundEngineState): Promise<void> {
    const sectors = sectorIds();

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO rounds (
           round_id, state, pick_open_at, lock_at, battle_end_at,
           matchmaking_seed, matchmaking_version, finalized_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (round_id) DO UPDATE SET
           state = EXCLUDED.state,
           finalized_at = EXCLUDED.finalized_at,
           updated_at = now()`,
        [
          state.roundId,
          state.state,
          toTimestamp(state.clock.pickOpenAt),
          toTimestamp(state.clock.lockAt),
          toTimestamp(state.clock.battleEndAt),
          state.matchmakingSeed,
          MATCHMAKING_VERSION,
          state.state === 'FINALIZED' ? toTimestamp(state.clock.battleEndAt) : null,
        ],
      );

      for (const [slot, battle] of state.battles.entries()) {
        await tx.query(
          `INSERT INTO battles (
             battle_id, round_id, left_ticker, right_ticker, sector_id, state,
             left_confidence, right_confidence,
             left_price_trend, left_volume_pulse, left_pons_activity, left_momentum_stability,
             right_price_trend, right_volume_pulse, right_pons_activity, right_momentum_stability,
             void_reason, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
           ON CONFLICT (battle_id) DO UPDATE SET
             state = EXCLUDED.state,
             void_reason = EXCLUDED.void_reason,
             updated_at = now()`,
          [
            battle.setup.battleId,
            state.roundId,
            battle.setup.left,
            battle.setup.right,
            sectors[slot] ?? sectors[0],
            battle.state,
            battle.setup.leftIntel.label,
            battle.setup.rightIntel.label,
            battle.setup.leftIntel.priceTrend,
            battle.setup.leftIntel.volumePulse,
            battle.setup.leftIntel.ponsActivity,
            battle.setup.leftIntel.momentumStability,
            battle.setup.rightIntel.priceTrend,
            battle.setup.rightIntel.volumePulse,
            battle.setup.rightIntel.ponsActivity,
            battle.setup.rightIntel.momentumStability,
            battle.voidReason,
          ],
        );
      }
    });
  }

  /**
   * Writes the round's results and awards (§25, §11).
   *
   * The state goes with them, in the same transaction, because a round marked
   * finalized without results is a round a restart would believe was finished.
   *
   * War Points are inserted `ON CONFLICT DO NOTHING` against the ledger's
   * idempotency index. §25 makes finalization exactly-once, and the way that
   * survives a retried finalization is by the second attempt conflicting rather
   * than crediting twice — the constraint decides it, not a flag this code
   * checks first and then acts on.
   */
  async saveFinalization(finalization: RoundFinalization): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.writeState(tx, finalization.state);

      for (const result of finalization.results) {
        await insertResult(tx, result);
      }
      for (const award of finalization.awards) {
        await insertAward(tx, finalization.state.roundId, award);
      }
    });
  }

  /** The body of `saveState`, reused inside the finalization transaction. */
  private async writeState(tx: SqlExecutor, state: RoundEngineState): Promise<void> {
    const store = new PostgresRoundStore(singleUse(tx));
    await store.saveState(state);
  }
}

/**
 * Matchmaking provenance (§4.3, §26).
 *
 * The seed alone does not let anyone recompute the pairings — the algorithm
 * that consumed it has to be identified too, or a future change to matchmaking
 * would make every historical round unverifiable while looking fine.
 */
const MATCHMAKING_VERSION = 'matchmaking-v1';

/** Turns an epoch-millisecond instant into something PostgreSQL will accept. */
function toTimestamp(at: number): string {
  return new Date(at).toISOString();
}

/**
 * Presents an executor as a database whose "transaction" is the caller's.
 *
 * PostgreSQL has savepoints but not nested transactions, and opening a second
 * one here would either fail or silently commit early. Reusing the outer
 * transaction is what the caller means: `saveFinalization` needs the state and
 * the results to land together.
 */
function singleUse(tx: SqlExecutor): SqlDatabase {
  return {
    query: (text, params) => tx.query(text, params),
    transaction: (work) => work(tx),
  };
}

async function insertResult(tx: SqlExecutor, result: FinalizedBattleResult): Promise<void> {
  await tx.query(
    `INSERT INTO battle_results (
       battle_id, round_id, left_ticker, right_ticker, winner_ticker,
       left_price_scaled, left_volume_scaled, left_pons_scaled, left_card_scaled,
       right_price_scaled, right_volume_scaled, right_pons_scaled, right_card_scaled,
       victory, tiebreak, scoring_engine_version, evidence_hash, finalized_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     -- §25 makes a result immutable from the moment it exists, so a retried
     -- finalization must not rewrite one. Doing nothing is the correct answer,
     -- not an error to report.
     ON CONFLICT (battle_id) DO NOTHING`,
    [
      result.battleId,
      result.roundId,
      result.left,
      result.right,
      result.winner,
      result.leftScore.priceMomentum,
      result.leftScore.relativeVolume,
      result.leftScore.ponsPower,
      result.leftScore.holderCardSupport,
      result.rightScore.priceMomentum,
      result.rightScore.relativeVolume,
      result.rightScore.ponsPower,
      result.rightScore.holderCardSupport,
      result.victoryLabel,
      result.tiebreakStep ?? null,
      result.scoringEngineVersion,
      result.evidenceHash,
      toTimestamp(result.finalizedAt),
    ],
  );
}

async function insertAward(tx: SqlExecutor, roundId: string, award: WpAward): Promise<void> {
  // The ledger references `wallet_profiles`, so a wallet that has never been
  // seen has to exist before its award does. Created rather than rejected: a
  // player's first round is not an error, and §49.2 makes the profile's
  // aggregates rebuildable from this ledger anyway.
  await tx.query(
    `INSERT INTO wallet_profiles (wallet, last_seen_at)
     VALUES ($1, now())
     ON CONFLICT (wallet) DO UPDATE SET last_seen_at = now()`,
    [award.wallet],
  );

  await tx.query(
    `INSERT INTO wp_ledger (wallet, round_id, battle_id, reason, points)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (wallet, battle_id, reason) DO NOTHING`,
    [award.wallet, roundId, award.battleId, award.reason, award.points],
  );
}
