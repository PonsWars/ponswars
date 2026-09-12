import {
  playerRecord,
  type OpenWindow,
  type PlayerRecord,
  type PlayerRecordSource,
  type SettledPick,
} from '@ponswars/player-service';
import {
  CONFIDENCE_LABELS,
  battleId,
  isActiveTicker,
  roundId,
  utcTimestamp,
  type ActiveTicker,
  type ConfidenceLabel,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import type { SqlExecutor, SqlRow } from './sql.js';

/**
 * A player's record, read from PostgreSQL (§34, §49.2).
 *
 * Reads the three ledgers finalization writes exactly once and hands them to
 * `playerRecord` — the same function the local stack's memory source uses, so
 * a win here is a win there.
 *
 * Only *locked* picks count, and only in battles that settled: the columns
 * frozen at lock are what the engine scored, and a battle still live has no
 * outcome to put in a record. A battle marked finalized without a result row is
 * left out rather than read as a loss — finalization writes the two together,
 * so a finalized battle with no result is a store in a state it should never
 * reach, and inventing an outcome for it is worse than a record that is one
 * battle short until someone looks.
 *
 * Every settled pick is read on each request. A wallet makes at most one pick a
 * round, which bounds this at 144 rows a day; a profile is read rarely; and one
 * derivation in one function is worth more than a cached aggregate that has to
 * be reconciled with it (§49.2).
 */
export class PostgresPlayerRecords implements PlayerRecordSource {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  async recordOf(wallet: WalletAddress): Promise<PlayerRecord> {
    const [settled, windowWarPoints, window] = await Promise.all([
      this.#settled(wallet),
      this.#windowWarPoints(wallet),
      this.#openWindow(),
    ]);
    return playerRecord({ wallet, settled, windowWarPoints, window });
  }

  async #settled(wallet: WalletAddress): Promise<SettledPick[]> {
    const { rows } = await this.#db.query(
      `SELECT p.round_id,
              p.locked_battle_id,
              b.left_ticker,
              b.right_ticker,
              b.left_confidence,
              b.right_confidence,
              b.state,
              p.locked_ticker,
              p.locked_card_decision,
              r.battle_end_at,
              res.winner_ticker,
              COALESCE((
                SELECT sum(l.points)
                  FROM wp_ledger l
                 WHERE l.wallet = p.wallet AND l.battle_id = p.locked_battle_id
              ), 0)::int AS war_points
         FROM player_picks p
         JOIN rounds r ON r.round_id = p.round_id
         JOIN battles b ON b.battle_id = p.locked_battle_id
         LEFT JOIN battle_results res ON res.battle_id = p.locked_battle_id
        WHERE p.wallet = $1
          AND p.locked_at IS NOT NULL
          AND (b.state = 'VOID' OR (b.state = 'FINALIZED' AND res.battle_id IS NOT NULL))`,
      [wallet],
    );
    return rows.map((row) => settledFrom(row));
  }

  async #windowWarPoints(wallet: WalletAddress): Promise<number> {
    // §16.2: a window's War Points begin after the previous snapshot, and a
    // snapshot claims the rows it counted by giving them its distribution id.
    const { rows } = await this.#db.query(
      `SELECT COALESCE(sum(points), 0)::int AS points
         FROM wp_ledger
        WHERE wallet = $1 AND distribution_id IS NULL`,
      [wallet],
    );
    return Number(rows[0]?.['points'] ?? 0);
  }

  async #openWindow(): Promise<OpenWindow | null> {
    const { rows } = await this.#db.query(
      `SELECT distribution_id, window_end
         FROM distribution_windows
        WHERE state = 'OPEN'
        ORDER BY window_start DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { distributionId: text(row['distribution_id']), closesAt: instant(row['window_end']) };
  }
}

function settledFrom(row: SqlRow): SettledPick {
  const left = ticker(row['left_ticker']);
  const right = ticker(row['right_ticker']);
  const winner = row['winner_ticker'];
  return {
    roundId: roundId(text(row['round_id'])),
    battleId: battleId(text(row['locked_battle_id'])),
    left,
    right,
    backed: ticker(row['locked_ticker']),
    cardDeployed: text(row['locked_card_decision']) === 'USE',
    settledAt: instant(row['battle_end_at']),
    warPoints: Number(row['war_points']),
    settlement:
      text(row['state']) === 'VOID' || winner === null
        ? { kind: 'VOID' }
        : {
            kind: 'DECIDED',
            winner: ticker(winner),
            winnerConfidence: confidence(
              ticker(winner) === left ? row['left_confidence'] : row['right_confidence'],
            ),
          },
  };
}

function ticker(value: unknown): ActiveTicker {
  const read = text(value);
  if (!isActiveTicker(read)) {
    throw new TypeError(`Stored ticker ${read} is not an active ticker`);
  }
  return read;
}

function confidence(value: unknown): ConfidenceLabel {
  const read = text(value);
  const label = CONFIDENCE_LABELS.find((candidate) => candidate === read);
  if (label === undefined) {
    throw new TypeError(`Stored confidence ${read} is not a confidence label`);
  }
  return label;
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
