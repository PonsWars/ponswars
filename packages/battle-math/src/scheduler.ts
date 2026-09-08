import {
  addDuration,
  buildCanonicalClock,
  ROUND_DURATION,
  type CanonicalClock,
  type DurationMs,
  type UtcTimestamp,
} from '@ponswars/shared-types';

/**
 * Canonical round scheduling (§72).
 *
 * *"Only backend canonical time determines phases. Frontend displays derived
 * countdowns."* Every function here takes an explicit server timestamp — none
 * reads a clock — so scheduling is a pure function of inputs and a replay
 * reproduces exactly what production did.
 */

/**
 * The instant round zero opened.
 *
 * Rounds run back-to-back from here, every ten minutes, indefinitely. The epoch
 * is configuration rather than a constant: it is a per-environment fact, and a
 * test schedule that shared production's epoch would be confusing rather than
 * wrong.
 */
export type RoundEpoch = UtcTimestamp;

/** Zero-based index of a round since the epoch. */
export type RoundIndex = number;

/**
 * The canonical clock for a round index.
 *
 * §72.2 requires the four boundaries to be **persisted** per round rather than
 * recomputed from a round number afterwards. This function is how a round's
 * timestamps are produced when it is created; after that the stored values are
 * authoritative, because a later change to the epoch or the round length must
 * not silently rewrite history.
 */
export function clockForRound(
  epoch: RoundEpoch,
  index: RoundIndex,
  serverTime: UtcTimestamp,
): CanonicalClock {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Round index must be a non-negative integer, received ${String(index)}`);
  }
  const pickOpenAt = addDuration(epoch, (index * ROUND_DURATION) as DurationMs);
  return buildCanonicalClock(pickOpenAt, serverTime);
}

/**
 * The round index covering an instant.
 *
 * Returns `null` before the epoch: there is no round -1, and returning 0 would
 * quietly place a pre-launch timestamp inside the first round.
 */
export function roundIndexAt(epoch: RoundEpoch, at: UtcTimestamp): RoundIndex | null {
  if (at < epoch) {
    return null;
  }
  return Math.floor((at - epoch) / ROUND_DURATION);
}

/**
 * Whether a pick or card decision received at `receivedAt` is still accepted.
 *
 * §72.4: *"A request received after `lock_at` is rejected even if the user's
 * screen still visually shows remaining milliseconds because of latency."*
 *
 * The comparison uses the server's receive time, never a client-supplied
 * instant, and the boundary is exclusive — a request arriving exactly at
 * `lockAt` is late. §3.2 locks *at* one minute, so that instant belongs to the
 * battle, not to the pick phase.
 */
export function acceptsPickAt(clock: CanonicalClock, receivedAt: UtcTimestamp): boolean {
  return receivedAt >= clock.pickOpenAt && receivedAt < clock.lockAt;
}

/**
 * How long the engine may wait past the cutoff for in-flight provider data.
 *
 * §72.5 allows a brief `FINALIZING` pause rather than fabricating a result when
 * required data is late but still within its provider's valid cadence — and
 * requires a configured maximum. Crossing it triggers data-integrity policy and
 * VOID, never an indefinite wait.
 *
 * `OPEN`: the value is per-provider calibration, so it is an input.
 */
export interface FinalizationPolicy {
  readonly maxWait: DurationMs;
}

export type FinalizationDecision = 'WAIT' | 'FINALIZE' | 'VOID';

/**
 * Decides what to do at or after the hard cutoff.
 *
 * Three outcomes and no fourth: finalize on complete data, wait briefly for
 * data that is late but still valid, or void. There is deliberately no path
 * that finalizes on incomplete data — Kickoff Brief §6 forbids synthesizing a
 * result to keep the UI moving.
 */
export function decideFinalization(
  clock: CanonicalClock,
  at: UtcTimestamp,
  requiredDataComplete: boolean,
  policy: FinalizationPolicy,
): FinalizationDecision {
  if (at < clock.battleEndAt) {
    throw new RangeError('Finalization cannot be decided before the hard cutoff');
  }
  if (requiredDataComplete) {
    return 'FINALIZE';
  }
  return at - clock.battleEndAt < policy.maxWait ? 'WAIT' : 'VOID';
}

/**
 * Deterministic round identifier.
 *
 * Derived from the index rather than random, so a replay tool can address a
 * round it was told about by number alone. Zero-padded to sort correctly as a
 * string, which is how it will appear in database indexes and log lines.
 */
export function roundIdFor(index: RoundIndex): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Round index must be a non-negative integer, received ${String(index)}`);
  }
  return `round-${index.toString().padStart(10, '0')}`;
}

/** Deterministic battle identifier within a round. */
export function battleIdFor(index: RoundIndex, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new RangeError(`Battle slot must be a non-negative integer, received ${String(slot)}`);
  }
  return `${roundIdFor(index)}-b${slot.toString()}`;
}

/** Deterministic sector identifier. Sectors are neutral and reused (§38.3). */
export function sectorIdFor(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new RangeError(`Sector slot must be a non-negative integer, received ${String(slot)}`);
  }
  return `sector-${(slot + 1).toString().padStart(2, '0')}`;
}
