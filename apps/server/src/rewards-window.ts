import { DISTRIBUTION_WINDOW, utcTimestamp, type UtcTimestamp } from '@ponswars/shared-types';
import type { DistributionWindow } from '@ponswars/store-postgres';

/**
 * What a rewards window needs next (§16.2).
 *
 * §16.2 makes the windows contiguous 24-hour periods, forever. Deciding which
 * step is due is arithmetic over one row, so it is a function rather than a
 * loop with a database in it — and the rules it encodes are the ones worth
 * testing:
 *
 * - The next window opens where the last one ended, not where the scheduler
 *   woke up. A late scheduler produces a late snapshot, never a short window.
 * - A window is snapshotted at its close and not before (§16.3).
 * - Nothing here calculates or publishes. Both have a human check in front of
 *   them (`docs/operations/rewards-distribution.md`): a snapshot is verified
 *   before it is calculated, and a root before it is published. A scheduler
 *   that ran ahead would be automating past the two steps that exist to be
 *   read by somebody.
 */

export type WindowStep =
  /** Open this window; nothing is open now. */
  | { readonly kind: 'OPEN'; readonly distributionId: bigint; readonly windowStart: UtcTimestamp }
  /** Its twenty-four hours are up. */
  | { readonly kind: 'SNAPSHOT'; readonly distributionId: bigint }
  /** Nothing to do until `until`. */
  | { readonly kind: 'WAIT'; readonly until: UtcTimestamp; readonly reason: string };

export function nextWindowStep(now: UtcTimestamp, latest: DistributionWindow | null): WindowStep {
  if (latest === null) {
    // The first window starts now: there is no earlier one to follow.
    return { kind: 'OPEN', distributionId: 1n, windowStart: now };
  }
  if (latest.state === 'OPEN') {
    return now >= latest.windowEnd
      ? { kind: 'SNAPSHOT', distributionId: latest.distributionId }
      : {
          kind: 'WAIT',
          until: latest.windowEnd,
          reason: `distribution ${latest.distributionId.toString()} closes`,
        };
  }
  // Snapshotted or beyond: the next window has been running since this one
  // ended, and is opened late rather than started late.
  return {
    kind: 'OPEN',
    distributionId: latest.distributionId + 1n,
    windowStart: latest.windowEnd,
  };
}

/** When a window opened at `windowStart` closes. */
export function windowEnd(windowStart: UtcTimestamp): UtcTimestamp {
  return utcTimestamp(windowStart + DISTRIBUTION_WINDOW);
}
