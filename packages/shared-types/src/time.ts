import type { Brand } from './brand.js';

/**
 * A point in time as milliseconds since the Unix epoch, always UTC.
 *
 * Engineering standard §66.5: every timestamp is persisted in UTC. The
 * frontend may localize for display but must never derive round authority from
 * the local device clock (§23.5) — the server owns time.
 */
export type UtcTimestamp = Brand<number, 'UtcTimestamp'>;

/** A duration in milliseconds. */
export type DurationMs = Brand<number, 'DurationMs'>;

/** Builds a {@link DurationMs} from whole seconds. */
export function seconds(count: number): DurationMs {
  return (count * 1_000) as DurationMs;
}

/** Builds a {@link DurationMs} from whole minutes. */
export function minutes(count: number): DurationMs {
  return (count * 60_000) as DurationMs;
}

/** Builds a {@link DurationMs} from whole hours. */
export function hours(count: number): DurationMs {
  return (count * 3_600_000) as DurationMs;
}

/** Offsets a timestamp by a duration. */
export function addDuration(at: UtcTimestamp, delta: DurationMs): UtcTimestamp {
  return (at + delta) as UtcTimestamp;
}

/** Signed distance from `from` to `to`. */
export function durationBetween(from: UtcTimestamp, to: UtcTimestamp): DurationMs {
  return (to - from) as DurationMs;
}

/**
 * The canonical time envelope every round payload carries (§5 of the Kickoff
 * Brief, masterplan §23.5).
 *
 * The client computes its countdown as a projection from these values plus the
 * observed clock offset. It never treats its own `Date.now()` as authority, so
 * a skewed device clock changes nothing about when a round locks.
 */
export interface CanonicalClock {
  /** Server time at the moment this payload was produced. */
  readonly serverTime: UtcTimestamp;
  /** When Pick Phase opened. */
  readonly pickOpenAt: UtcTimestamp;
  /** When picks lock — exactly one minute after `pickOpenAt` (§3.2). */
  readonly lockAt: UtcTimestamp;
  /** When the scoring window opens. Equal to `lockAt` (§12.1). */
  readonly battleStartAt: UtcTimestamp;
  /** Hard scoring cutoff. Data after this instant is excluded (§12.6). */
  readonly battleEndAt: UtcTimestamp;
}
