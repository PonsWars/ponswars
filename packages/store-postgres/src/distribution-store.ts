import {
  baseUnits,
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
import { allocateDistribution, buildMerkleTree } from '@ponswars/rewards-math';
import type { SqlDatabase, SqlExecutor } from './sql.js';

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

/**
 * A calculated window: the root to publish and what it commits (§17).
 *
 * `root` is `null` when no wallet is above the minimum claim — there is then no
 * tree, nothing to publish, and the whole pool carries forward (§16.7).
 */
export interface CalculatedDistribution {
  readonly distributionId: bigint;
  readonly state: 'CALCULATED' | 'PUBLISHED' | 'CLOSED';
  readonly root: `0x${string}` | null;
  /** The sum the root allocates, committed on chain at publication. */
  readonly total: BaseUnits;
  readonly claimable: number;
  readonly minimumClaim: BaseUnits;
  readonly publicationTx: `0x${string}` | null;
}

/** A wallet's published allocation, with what `RewardsDistributor.claim` takes. */
export interface PublishedClaim {
  readonly distributionId: bigint;
  readonly amount: BaseUnits;
  readonly proof: readonly `0x${string}`[];
  readonly root: `0x${string}`;
}

/**
 * The allocation algorithm this store calculates with (§66.4).
 *
 * Recorded on every window, so a window calculated before the algorithm changes
 * stays recomputable under the rules it was calculated with.
 */
export const ALLOCATION_ALGORITHM_VERSION = 'allocation-v1';

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

  /**
   * Calculates a snapshotted window: allocations, carry-forward and the tree (§16, §17).
   *
   * The same arithmetic `tools/verify-distribution.mjs` runs on the snapshot
   * file, run here on the War Points the snapshot claimed, so the root this
   * prints is the root that tool must reproduce before anyone publishes it.
   * Every qualified wallet gets a row — paid this window, or carried forward —
   * and each paid one stores its leaf and proof exactly as calculated.
   *
   * Once, in one transaction. A window already calculated is refused rather
   * than recalculated: what it produced may already be on chain.
   */
  calculate(input: {
    readonly distributionId: bigint;
    readonly minimumClaim: BaseUnits;
  }): Promise<CalculatedDistribution> {
    const id = identifier(input.distributionId);
    if (id === null) {
      return Promise.reject(new DistributionError('A distribution id is a non-negative integer.'));
    }
    if (input.minimumClaim < 0n) {
      return Promise.reject(new DistributionError('A minimum claim is never negative.'));
    }

    return this.#db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DISTRIBUTION_LOCK]);

      const { rows } = await tx.query(
        `SELECT state, pool_snapshot::text AS pool FROM distribution_windows
          WHERE distribution_id = $1 FOR UPDATE`,
        [id],
      );
      const window = rows[0];
      if (window === undefined) {
        throw new DistributionError(`There is no distribution ${id}.`);
      }
      if (window['state'] !== 'SNAPSHOT') {
        throw new DistributionError(
          `Distribution ${id} is ${String(window['state'])}, not SNAPSHOT. A window is calculated once, after its snapshot.`,
        );
      }

      const totals = await tx.query(
        `SELECT wallet, sum(points)::int AS points
           FROM wp_ledger
          WHERE distribution_id = $1
          GROUP BY wallet
          ORDER BY wallet COLLATE "C"`,
        [id],
      );
      const result = allocateDistribution({
        poolBalance: baseUnits(BigInt(String(window['pool']))),
        minimumClaim: input.minimumClaim,
        standings: totals.rows.map((row) => ({
          wallet: walletAddress(String(row['wallet'])),
          windowWarPoints: Number(row['points']),
        })),
      });

      const claimable = result.allocations.filter((allocation) => allocation.amount > 0n);
      const tree = claimable.length === 0 ? null : buildMerkleTree(input.distributionId, claimable);
      const proofs = new Map(tree?.claims.map((claim) => [claim.wallet, claim]) ?? []);

      for (const allocation of result.allocations) {
        const claim = proofs.get(allocation.wallet);
        await tx.query(
          `INSERT INTO reward_allocations (
             distribution_id, wallet, window_war_points, weight, amount, carried_forward,
             capped, state, merkle_leaf, merkle_proof
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            allocation.wallet,
            allocation.windowWarPoints,
            allocation.weight.toString(),
            allocation.amount.toString(),
            allocation.carriedForward.toString(),
            allocation.capped,
            claim === undefined ? 'CARRIED_FORWARD' : 'CALCULATED',
            claim?.leaf ?? null,
            claim === undefined ? null : JSON.stringify(claim.proof),
          ],
        );
        if (allocation.carriedForward > 0n) {
          await tx.query(
            `INSERT INTO reward_carry_forward (wallet, amount, last_distribution_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (wallet) DO UPDATE
               SET amount = reward_carry_forward.amount + EXCLUDED.amount,
                   last_distribution_id = EXCLUDED.last_distribution_id,
                   updated_at = now()`,
            [allocation.wallet, allocation.carriedForward.toString(), id],
          );
        }
      }

      await tx.query(
        `UPDATE distribution_windows
            SET state = 'CALCULATED', minimum_claim = $2, merkle_root = $3,
                algorithm_version = $4, updated_at = now()
          WHERE distribution_id = $1`,
        [id, input.minimumClaim.toString(), tree?.root ?? null, ALLOCATION_ALGORITHM_VERSION],
      );

      return readCalculated(tx, input.distributionId);
    });
  }

  /** A calculated window as recorded, or `null` for one not calculated yet. */
  async calculated(distributionId: bigint): Promise<CalculatedDistribution | null> {
    try {
      return await readCalculated(this.#db, distributionId);
    } catch (error: unknown) {
      if (error instanceof DistributionError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Records that a calculated window's root is on chain (§17).
   *
   * The caller has read the root and total back from `RewardsDistributor`; they
   * must be the ones calculated, or this refuses — a window is never marked
   * published against a root it did not produce.
   */
  recordPublication(input: {
    readonly distributionId: bigint;
    readonly onChainRoot: `0x${string}`;
    readonly onChainTotal: BaseUnits;
    readonly publicationTx: `0x${string}`;
  }): Promise<CalculatedDistribution> {
    const id = identifier(input.distributionId);
    if (id === null) {
      return Promise.reject(new DistributionError('A distribution id is a non-negative integer.'));
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.publicationTx)) {
      return Promise.reject(new DistributionError('A publication transaction is a 32-byte hash.'));
    }

    return this.#db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DISTRIBUTION_LOCK]);
      const calculated = await readCalculated(tx, input.distributionId);
      if (calculated.state !== 'CALCULATED') {
        throw new DistributionError(`Distribution ${id} is already ${calculated.state}.`);
      }
      if (calculated.root === null) {
        throw new DistributionError(
          `Distribution ${id} has no claimable allocation, so there is no root to publish.`,
        );
      }
      if (
        input.onChainRoot.toLowerCase() !== calculated.root ||
        input.onChainTotal !== calculated.total
      ) {
        throw new DistributionError(
          `Distribution ${id} on chain has root ${input.onChainRoot} and total ${input.onChainTotal.toString()}, ` +
            `but it was calculated as ${calculated.root} and ${calculated.total.toString()}. Nothing was recorded.`,
        );
      }

      await tx.query(
        `UPDATE distribution_windows
            SET state = 'PUBLISHED', publication_tx = $2, published_at = now(), updated_at = now()
          WHERE distribution_id = $1`,
        [id, input.publicationTx.toLowerCase()],
      );
      await tx.query(
        `UPDATE reward_allocations SET state = 'PUBLISHED', updated_at = now()
          WHERE distribution_id = $1 AND state = 'CALCULATED'`,
        [id],
      );
      return readCalculated(tx, input.distributionId);
    });
  }

  /** A wallet's allocations in published windows, with their proofs (§17). */
  async publishedClaims(wallet: WalletAddress): Promise<readonly PublishedClaim[]> {
    const { rows } = await this.#db.query(
      `SELECT a.distribution_id, a.amount::text AS amount, a.merkle_proof, w.merkle_root
         FROM reward_allocations a
         JOIN distribution_windows w ON w.distribution_id = a.distribution_id
        WHERE a.wallet = $1 AND a.amount > 0 AND w.state IN ('PUBLISHED', 'CLOSED')
        ORDER BY a.distribution_id::numeric DESC`,
      [wallet],
    );
    return rows.map((row) => ({
      distributionId: BigInt(String(row['distribution_id'])),
      amount: baseUnits(BigInt(String(row['amount']))),
      proof: hashList(row['merkle_proof']),
      root: hash(row['merkle_root']),
    }));
  }
}

/** One lock for every window change, so opening and snapshotting never interleave. */
const DISTRIBUTION_LOCK = 721_204_620;

async function readCalculated(
  db: SqlExecutor,
  distributionId: bigint,
): Promise<CalculatedDistribution> {
  const id = identifier(distributionId) ?? '';
  const { rows } = await db.query(
    `SELECT w.state, w.merkle_root, w.minimum_claim::text AS minimum_claim, w.publication_tx,
            coalesce(sum(a.amount), 0)::text AS total,
            count(a.merkle_leaf)::int AS claimable
       FROM distribution_windows w
       LEFT JOIN reward_allocations a ON a.distribution_id = w.distribution_id
      WHERE w.distribution_id = $1
      GROUP BY w.distribution_id`,
    [id],
  );
  const row = rows[0];
  const state = row?.['state'];
  if (
    row === undefined ||
    (state !== 'CALCULATED' && state !== 'PUBLISHED' && state !== 'CLOSED')
  ) {
    throw new DistributionError(`Distribution ${id} has not been calculated.`);
  }
  return {
    distributionId,
    state,
    root: row['merkle_root'] === null ? null : hash(row['merkle_root']),
    total: baseUnits(BigInt(String(row['total']))),
    claimable: Number(row['claimable']),
    minimumClaim: baseUnits(BigInt(String(row['minimum_claim']))),
    publicationTx: row['publication_tx'] === null ? null : hash(row['publication_tx']),
  };
}

function hash(value: unknown): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`Expected a stored 32-byte hash, got ${String(value)}`);
  }
  return value as `0x${string}`;
}

function hashList(value: unknown): `0x${string}`[] {
  const list: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(list)) {
    throw new TypeError('Expected a stored Merkle proof list');
  }
  return list.map((item: unknown) => hash(item));
}

/** The stored identifier, or `null` for one the claim contract could not commit to. */
function identifier(distributionId: bigint): string | null {
  return distributionId < 0n ? null : distributionId.toString();
}

function iso(at: UtcTimestamp): string {
  return new Date(at).toISOString();
}
