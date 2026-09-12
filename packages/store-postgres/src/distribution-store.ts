import {
  DISTRIBUTION_WINDOW,
  POOL_DISTRIBUTABLE_BPS,
  qualifiesForDistribution,
  rewardWeight,
  utcTimestamp,
  walletAddress,
  type BaseUnits,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import type { SqlDatabase } from './sql.js';

/**
 * Distribution windows, opened and snapshotted (§16.2, §16.3, §49.11).
 *
 * The first two steps of `OPEN → SNAPSHOT → CALCULATED → PUBLISHED → CLOSED`.
 * Everything after the snapshot is arithmetic on what the snapshot fixed —
 * `tools/verify-distribution.mjs` recomputes it — so these two are where a
 * mistake is made or avoided, and each refuses the ones it can recognise.
 *
 * A window's War Points are the ledger rows no earlier snapshot claimed
 * (§16.2), and the snapshot is what claims them. It is one statement against
 * the ledger, so a round finalizing at the same instant either committed first
 * and is in this window, or committed after and is in the next one — never
 * half in each, and never in both.
 *
 * Identifiers are integers, because the claim contract commits to the
 * distribution id inside every Merkle leaf (§17). The schema stores it as text,
 * which is how it can hold them without a width decision; this is where
 * anything that is not a non-negative integer is refused.
 */

/** What a window is calculated from. The snapshot file carries exactly this. */
export interface DistributionSnapshot {
  readonly distributionId: bigint;
  /** The Rewards Distribution wallet's balance at snapshot, in base units (§16.3). */
  readonly poolBalance: BaseUnits;
  /** Every wallet with War Points in the window, qualified or not, ordered by wallet. */
  readonly standings: readonly {
    readonly wallet: WalletAddress;
    readonly windowWarPoints: number;
  }[];
}

/** A step refused because it would put a window somewhere §16 does not allow. */
export class DistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistributionError';
  }
}

export class PostgresDistributionStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /**
   * Opens a 24-hour window starting at `windowStart` (§16.2).
   *
   * One open window at a time. Two would split the unclaimed War Points between
   * them by whichever snapshot ran first, which is not a rule anybody wrote.
   */
  openWindow(input: {
    readonly distributionId: bigint;
    readonly windowStart: UtcTimestamp;
  }): Promise<{ readonly windowEnd: UtcTimestamp }> {
    const id = identifier(input.distributionId);
    if (id === null) {
      return Promise.reject(new DistributionError('A distribution id is a non-negative integer.'));
    }
    const windowEnd = utcTimestamp(input.windowStart + DISTRIBUTION_WINDOW);

    return this.#db.transaction(async (tx) => {
      // Serialised against another operator opening a window at the same time,
      // which is exactly when "is one already open?" gets the wrong answer.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DISTRIBUTION_LOCK]);

      const open = await tx.query(
        `SELECT distribution_id FROM distribution_windows WHERE state = 'OPEN' LIMIT 1`,
      );
      const current = open.rows[0];
      if (current !== undefined) {
        throw new DistributionError(
          `Distribution ${String(current['distribution_id'])} is still open. Snapshot it before opening another.`,
        );
      }
      const existing = await tx.query(
        'SELECT 1 FROM distribution_windows WHERE distribution_id = $1',
        [id],
      );
      if (existing.rows.length > 0) {
        throw new DistributionError(
          `Distribution ${id} already exists. Identifiers are never reused: the claim contract commits to them.`,
        );
      }

      await tx.query(
        `INSERT INTO distribution_windows (distribution_id, state, window_start, window_end)
         VALUES ($1, 'OPEN', $2, $3)`,
        [id, iso(input.windowStart), iso(windowEnd)],
      );
      return { windowEnd };
    });
  }

  /**
   * Snapshots an open window whose 24 hours are over (§16.2, §16.3).
   *
   * Claims every unclaimed War Point for the window, fixes the pool balance and
   * the distributable 80%, records how many wallets qualified and their total
   * weight, and moves the window to `SNAPSHOT` — all in one transaction, so a
   * failure leaves the window open and the ledger untouched.
   *
   * The pool balance is the operator's reading of the Rewards Distribution
   * wallet at this moment. Funding is manual (§44.7) and nothing reads the chain
   * yet (§59.3); when something does, it supplies this number and nothing else
   * here changes.
   */
  snapshot(input: {
    readonly distributionId: bigint;
    readonly poolBalance: BaseUnits;
  }): Promise<DistributionSnapshot> {
    const id = identifier(input.distributionId);
    if (id === null) {
      return Promise.reject(new DistributionError('A distribution id is a non-negative integer.'));
    }
    if (input.poolBalance < 0n) {
      return Promise.reject(new DistributionError('A pool balance is never negative.'));
    }

    return this.#db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DISTRIBUTION_LOCK]);

      const { rows } = await tx.query(
        `SELECT state, window_end <= now() AS over
           FROM distribution_windows
          WHERE distribution_id = $1
          FOR UPDATE`,
        [id],
      );
      const window = rows[0];
      if (window === undefined) {
        throw new DistributionError(`There is no distribution ${id}.`);
      }
      if (window['state'] !== 'OPEN') {
        throw new DistributionError(
          `Distribution ${id} is ${String(window['state'])}, not OPEN. A window is snapshotted once.`,
        );
      }
      if (window['over'] !== true) {
        throw new DistributionError(
          `Distribution ${id} has not closed yet. §16.2 snapshots a window at the end of its 24 hours.`,
        );
      }

      await tx.query('UPDATE wp_ledger SET distribution_id = $1 WHERE distribution_id IS NULL', [
        id,
      ]);
      const totals = await tx.query(
        `SELECT wallet, sum(points)::int AS points
           FROM wp_ledger
          WHERE distribution_id = $1
          GROUP BY wallet
          ORDER BY wallet COLLATE "C"`,
        [id],
      );
      const standings = totals.rows.map((row) => ({
        wallet: walletAddress(String(row['wallet'])),
        windowWarPoints: Number(row['points']),
      }));

      const qualified = standings.filter((standing) =>
        qualifiesForDistribution(standing.windowWarPoints),
      );
      const totalWeight = qualified.reduce(
        (sum, standing) => sum + rewardWeight(standing.windowWarPoints),
        0n,
      );

      // `distributable` is written as the arithmetic §16.3 states, and the
      // table's check constraint recomputes it — a wrong split is refused by the
      // database rather than recorded.
      await tx.query(
        `UPDATE distribution_windows
            SET state = 'SNAPSHOT',
                pool_snapshot = $2,
                distributable = $3,
                qualified_wallets = $4,
                total_qualified_weight = $5,
                updated_at = now()
          WHERE distribution_id = $1`,
        [
          id,
          input.poolBalance.toString(),
          ((input.poolBalance * BigInt(POOL_DISTRIBUTABLE_BPS)) / 10_000n).toString(),
          qualified.length,
          totalWeight.toString(),
        ],
      );

      return { distributionId: input.distributionId, poolBalance: input.poolBalance, standings };
    });
  }
}

/** One lock for every window change, so opening and snapshotting never interleave. */
const DISTRIBUTION_LOCK = 721_204_620;

/** The stored identifier, or `null` for one the claim contract could not commit to. */
function identifier(distributionId: bigint): string | null {
  return distributionId < 0n ? null : distributionId.toString();
}

function iso(at: UtcTimestamp): string {
  return new Date(at).toISOString();
}
