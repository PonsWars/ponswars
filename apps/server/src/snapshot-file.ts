import type { DistributionSnapshot } from '@ponswars/store-postgres';
import type { BaseUnits } from '@ponswars/shared-types';
import { open, unlink } from 'node:fs/promises';

/**
 * Taking a window's snapshot and writing the file the runbook verifies
 * (§16.3, `docs/operations/rewards-distribution.md`).
 *
 * Two callers do this — the operator command (`distribution.js snapshot`) and
 * the worker that keeps windows on time (`rewards-worker.js`) — and they had a
 * copy each. The copies had drifted: one cleaned up after a failure and the
 * other did not, which is the difference between a window that can be
 * snapshotted on the next pass and one that never can.
 *
 * The order is the part worth keeping:
 *
 * 1. **Claim the file first**, with `wx`. A snapshot commits and cannot be
 *    taken twice (§16.3), so a file that failed to open *afterwards* would
 *    leave the window snapshotted and its standings on no disk. `wx` also
 *    refuses a name already taken: two snapshot files under one name is how
 *    the wrong one gets verified and the wrong root published.
 * 2. **Take the snapshot**, which is what commits.
 * 3. **Write what was taken.**
 *
 * And when the snapshot is refused, the empty file is removed again. Left
 * behind, it is a name already taken: every later attempt fails at step one
 * for a window that was never snapshotted at all, which the worker would
 * report as late for as long as it ran.
 */

/** The little of the distribution store this needs. */
export interface SnapshotStore {
  snapshot(input: {
    readonly distributionId: bigint;
    readonly poolBalance: BaseUnits;
  }): Promise<DistributionSnapshot>;
}

export interface SnapshotRequest {
  readonly store: SnapshotStore;
  readonly distributionId: bigint;
  /** The distributor's uncommitted balance at this instant (§16.3). */
  readonly poolBalance: BaseUnits;
  /** The minimum claim in base units, recorded so the calculation uses the snapshot's own (§16.7). */
  readonly minimumClaim: bigint;
  /** Where the file goes. */
  readonly path: string;
}

export async function writeSnapshot(request: SnapshotRequest): Promise<DistributionSnapshot> {
  const handle = await open(request.path, 'wx');
  let taken: DistributionSnapshot;
  try {
    taken = await request.store.snapshot({
      distributionId: request.distributionId,
      poolBalance: request.poolBalance,
    });
  } catch (error: unknown) {
    // Nothing was taken, so nothing belongs in the file — and leaving it would
    // refuse every later attempt at a window that still has no snapshot.
    await handle.close();
    await unlink(request.path).catch(() => undefined);
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify(
        {
          distributionId: taken.distributionId.toString(),
          poolBalance: taken.poolBalance.toString(),
          minimumClaim: request.minimumClaim.toString(),
          standings: taken.standings,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    // Kept even if the write failed: the snapshot is taken and cannot be taken
    // again, so the file's name must stay claimed for the operator to fill
    // from the database rather than be quietly reused.
    await handle.close();
  }
  return taken;
}
