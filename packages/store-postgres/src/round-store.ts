import {
  EMPTY_EVIDENCE,
  sectorIds,
  type BattleEngineState,
  type RoundEngineState,
  type RoundFinalization,
  type WpAward,
} from '@ponswars/battle-engine';
import { INITIAL_MOMENTUM_MEMORY, type SideInputs } from '@ponswars/battle-math';
import type { RoundStorePort } from '@ponswars/round-service';
import {
  battleId as toBattleId,
  buildCanonicalClock,
  roundId as toRoundId,
  utcTimestamp,
  type CanonicalClock,
  type ConfidenceSnapshot,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import type { SqlDatabase, SqlExecutor, SqlRow } from './sql.js';

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

        // After the battle row, never before: the evidence table references it,
        // so a checkpoint written first would fail the foreign key on the very
        // first save of a round.
        await writeCheckpoint(tx, battle);
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

  /**
   * The most recent round, restored from its checkpoint (§25).
   *
   * The latest tick row per battle is the restore point. `battle_tick_evidence`
   * was written to be exactly that, and migration 0008 added the parts of the
   * engine state it was missing — a process resuming from scores alone would
   * come back with a fresh momentum window and a broken evidence chain, which is
   * a different battle that happens to have the same score.
   *
   * A battle that has never ticked has no row, and that is the right answer
   * rather than a missing one: it resumes exactly where an unscored battle
   * starts.
   */
  async loadLatest(): Promise<RoundEngineState | null> {
    const rounds = await this.db.query(
      `SELECT round_id, state, pick_open_at, matchmaking_seed
       FROM rounds ORDER BY pick_open_at DESC LIMIT 1`,
    );
    const round = rounds.rows[0];
    if (round === undefined) {
      return null;
    }

    const roundId = text(round['round_id']);
    const battles = await this.db.query(
      `SELECT b.battle_id, b.round_id, b.left_ticker, b.right_ticker, b.state, b.void_reason,
              b.left_confidence, b.left_price_trend, b.left_volume_pulse,
              b.left_pons_activity, b.left_momentum_stability,
              b.right_confidence, b.right_price_trend, b.right_volume_pulse,
              b.right_pons_activity, b.right_momentum_stability,
              e.tick_sequence, e.observed_at, e.left_score_scaled, e.right_score_scaled,
              e.momentum_peak_left, e.momentum_peak_right, e.momentum_previous,
              e.momentum_ticks, e.evidence_hash, e.left_inputs, e.right_inputs
       FROM battles b
       -- The newest checkpoint for that battle, or nothing if it never ticked.
       LEFT JOIN LATERAL (
         SELECT * FROM battle_tick_evidence t
         WHERE t.battle_id = b.battle_id
         ORDER BY t.tick_sequence DESC LIMIT 1
       ) e ON true
       WHERE b.round_id = $1
       ORDER BY b.sector_id`,
      [roundId],
    );

    // Rebuilt from `pick_open_at` rather than stored field by field: §3.2 fixes
    // the lock at one minute and §3.1 the end at ten, and the schema already
    // refuses a row that disagrees. Reading three columns that are defined by
    // the first would be three chances to restore a round with a clock the
    // engine could not have produced.
    const openedAt = utcTimestamp(instant(round['pick_open_at']));
    const clock = buildCanonicalClock(openedAt, openedAt);

    return {
      roundId: toRoundId(roundId),
      state: text(round['state']) as RoundEngineState['state'],
      clock,
      matchmakingSeed: text(round['matchmaking_seed']),
      // Picks are not part of the checkpoint. §22 freezes them into the engine
      // at the moment of locking, so a round restored before its lock reads
      // them from the pick store again, and one restored after has already
      // consumed them into the battles above.
      picks: [],
      battles: battles.rows.map((row) => toBattleState(row, clock)),
    };
  }

  /** The body of `saveState`, reused inside the finalization transaction. */
  private async writeState(tx: SqlExecutor, state: RoundEngineState): Promise<void> {
    const store = new PostgresRoundStore(singleUse(tx));
    await store.saveState(state);
  }
}

/**
 * Appends the battle's current checkpoint (§25).
 *
 * Keyed on `(battle_id, tick_sequence)`, so saving the same state twice writes
 * one row. The loop saves after every tick and after every transition, and a
 * transition that scored nothing must not leave a second checkpoint behind at a
 * sequence that already has one.
 *
 * A battle that has never been scored has nothing to checkpoint. A row of zeroes
 * would make "not started" indistinguishable from "scored level".
 */
async function writeCheckpoint(tx: SqlExecutor, battle: BattleEngineState): Promise<void> {
  if (battle.lastTickAt === null) {
    return;
  }

  await tx.query(
    `INSERT INTO battle_tick_evidence (
       battle_id, tick_sequence, observed_at,
       left_score_scaled, right_score_scaled, frontline_scaled,
       left_feed_health, right_feed_health,
       momentum_peak_left, momentum_peak_right, momentum_previous, momentum_ticks,
       evidence_hash, left_inputs, right_inputs
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (battle_id, tick_sequence) DO NOTHING`,
    [
      battle.setup.battleId,
      battle.tickSequence,
      toTimestamp(battle.lastTickAt),
      battle.leftScoreScaled.toString(),
      battle.rightScoreScaled.toString(),
      frontlineScaled(battle),
      'HEALTHY',
      'HEALTHY',
      battle.momentum.peakLeft.toString(),
      battle.momentum.peakRight.toString(),
      battle.momentum.previous.toString(),
      battle.momentum.ticks,
      battle.evidenceHash,
      JSON.stringify(encodeInputs(battle.lastLeft)),
      JSON.stringify(encodeInputs(battle.lastRight)),
    ],
  );
}

/**
 * Where the frontline stands, as the schema's 0–1 000 000 integer.
 *
 * Derived from the two scores rather than carried alongside them, because it is
 * a rendering of them (§13.4). A stored copy is a second answer that can
 * disagree with the first.
 */
function frontlineScaled(battle: BattleEngineState): number {
  const total = battle.leftScoreScaled + battle.rightScoreScaled;
  if (total <= 0n) {
    return 500_000;
  }
  return Number((battle.leftScoreScaled * 1_000_000n) / total);
}

/** Scoring inputs, with every scaled integer as a string (§66.4). */
function encodeInputs(inputs: SideInputs | null): unknown {
  if (inputs === null) {
    return null;
  }
  return {
    windowReturn: inputs.windowReturn.toString(),
    volatility: inputs.volatility.toString(),
    relativeVolume: inputs.relativeVolume.toString(),
    qualifiedPonsActivity: inputs.qualifiedPonsActivity.toString(),
    uniqueActiveWallets: inputs.uniqueActiveWallets.toString(),
    cardSupport: {
      market: inputs.cardSupport.market.toString(),
      volume: inputs.cardSupport.volume.toString(),
      pons: inputs.cardSupport.pons.toString(),
      general: inputs.cardSupport.general.toString(),
    },
  };
}

/** Reads back what {@link encodeInputs} wrote. */
function decodeInputs(value: unknown): SideInputs | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const card = (raw['cardSupport'] ?? {}) as Record<string, unknown>;
  return {
    windowReturn: big(raw['windowReturn']),
    volatility: big(raw['volatility']),
    relativeVolume: big(raw['relativeVolume']),
    qualifiedPonsActivity: big(raw['qualifiedPonsActivity']),
    uniqueActiveWallets: big(raw['uniqueActiveWallets']),
    cardSupport: {
      market: big(card['market']),
      volume: big(card['volume']),
      pons: big(card['pons']),
      general: big(card['general']),
    },
  };
}

/** One battle, rebuilt from its row and its latest checkpoint. */
function toBattleState(row: SqlRow, clock: CanonicalClock): BattleEngineState {
  const ticked = row['tick_sequence'] !== null && row['tick_sequence'] !== undefined;

  return {
    setup: {
      battleId: toBattleId(text(row['battle_id'])),
      roundId: toRoundId(text(row['round_id'])),
      left: text(row['left_ticker']) as BattleEngineState['setup']['left'],
      right: text(row['right_ticker']) as BattleEngineState['setup']['right'],
      clock,
      leftIntel: intelFrom(row, 'left'),
      rightIntel: intelFrom(row, 'right'),
    },
    state: text(row['state']) as BattleEngineState['state'],
    tickSequence: ticked ? Number(row['tick_sequence']) : 0,
    momentum: ticked
      ? {
          peakLeft: big(row['momentum_peak_left']),
          peakRight: big(row['momentum_peak_right']),
          previous: big(row['momentum_previous']),
          ticks: Number(row['momentum_ticks']),
        }
      : INITIAL_MOMENTUM_MEMORY,
    evidenceHash: ticked ? text(row['evidence_hash']) : EMPTY_EVIDENCE,
    leftScoreScaled: ticked ? big(row['left_score_scaled']) : 0n,
    rightScoreScaled: ticked ? big(row['right_score_scaled']) : 0n,
    lastLeft: ticked ? decodeInputs(row['left_inputs']) : null,
    lastRight: ticked ? decodeInputs(row['right_inputs']) : null,
    lastTickAt: ticked ? utcTimestamp(instant(row['observed_at'])) : null,
    voidReason:
      row['void_reason'] === null || row['void_reason'] === undefined
        ? null
        : (text(row['void_reason']) as BattleEngineState['voidReason']),
  };
}

/** One side's confidence snapshot, from its five columns. */
function intelFrom(row: SqlRow, side: 'left' | 'right'): ConfidenceSnapshot {
  return {
    label: text(row[`${side}_confidence`]) as ConfidenceSnapshot['label'],
    priceTrend: text(row[`${side}_price_trend`]) as ConfidenceSnapshot['priceTrend'],
    volumePulse: text(row[`${side}_volume_pulse`]) as ConfidenceSnapshot['volumePulse'],
    ponsActivity: text(row[`${side}_pons_activity`]) as ConfidenceSnapshot['ponsActivity'],
    momentumStability: text(
      row[`${side}_momentum_stability`],
    ) as ConfidenceSnapshot['momentumStability'],
  };
}

/**
 * A scaled integer from a column, whatever the driver made of it.
 *
 * `pg` hands a `BIGINT` back as a string and `PGlite` as a number. Going through
 * `BigInt` rather than trusting either is what keeps §66.4's integer arithmetic
 * true across a driver choice this package deliberately does not make.
 */
function big(value: unknown): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  // Not stringified and hoped for. `String()` on an object yields
  // `[object Object]`, which `BigInt` would reject here but which the sibling
  // below would happily store as a battle id — the same shape of bug as a
  // fragmented socket frame read with `toString()`.
  throw new TypeError(`Expected a numeric column, got ${typeof value}`);
}

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  throw new TypeError(`Expected a text column, got ${typeof value}`);
}

/** An instant from a `TIMESTAMPTZ`, which a driver may hand back as a `Date`. */
function instant(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
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
/**
 * One finalized result, by battle (§25, §27.8, §47.3).
 *
 * The result screen is the one surface in the product that shows a score, and
 * without this the deployable service had no way to answer for one — the loop
 * wrote results it could never read back, so a shared `/result/:battleId` link
 * returned `404` for a battle that had definitely finished.
 *
 * `null` for a battle that has not finalized, which is a normal answer rather
 * than an error: §22 makes a result exist only after finalization, and every
 * battle spends most of its life before that.
 *
 * Numbers come back as `bigint` from the driver and are narrowed here, because
 * `FinalizedBattleResult` carries `number` at the boundary — the four
 * components are scaled points under 1e8, so the narrowing is exact rather
 * than hopeful.
 */
export async function readFinalizedResult(
  db: SqlExecutor,
  battleId: string,
): Promise<FinalizedBattleResult | null> {
  const { rows } = await db.query(
    `SELECT battle_id, round_id, left_ticker, right_ticker, winner_ticker,
            left_price_scaled, left_volume_scaled, left_pons_scaled, left_card_scaled,
            right_price_scaled, right_volume_scaled, right_pons_scaled, right_card_scaled,
            victory, tiebreak, scoring_engine_version, evidence_hash, finalized_at
       FROM battle_results
      WHERE battle_id = $1`,
    [battleId],
  );

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    battleId: toBattleId(text(row['battle_id'])),
    roundId: toRoundId(text(row['round_id'])),
    left: text(row['left_ticker']),
    right: text(row['right_ticker']),
    winner: text(row['winner_ticker']),
    leftScore: {
      priceMomentum: Number(big(row['left_price_scaled'])),
      relativeVolume: Number(big(row['left_volume_scaled'])),
      ponsPower: Number(big(row['left_pons_scaled'])),
      holderCardSupport: Number(big(row['left_card_scaled'])),
    },
    rightScore: {
      priceMomentum: Number(big(row['right_price_scaled'])),
      relativeVolume: Number(big(row['right_volume_scaled'])),
      ponsPower: Number(big(row['right_pons_scaled'])),
      holderCardSupport: Number(big(row['right_card_scaled'])),
    },
    victoryLabel: text(row['victory']),
    // Absent rather than empty when there was no tiebreak: §12.7 makes naming
    // the step meaningful, and `''` would be a step nobody can look up.
    ...(row['tiebreak'] === null || row['tiebreak'] === undefined
      ? {}
      : { tiebreakStep: text(row['tiebreak']) }),
    scoringEngineVersion: text(row['scoring_engine_version']),
    evidenceHash: text(row['evidence_hash']),
    finalizedAt: utcTimestamp(instant(row['finalized_at'])),
  } as FinalizedBattleResult;
}

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
