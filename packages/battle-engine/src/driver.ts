import {
  FINAL_PUSH_DURATION,
  isTerminalRoundState,
  type CanonicalClock,
  type DurationMs,
  type RoundState,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import type { RoundEngineState } from './round.js';

/**
 * What a round needs next, given the time (§3, §22, §68).
 *
 * The round operations — create, lock, tick, finalize — each know how to do one
 * thing. Nothing decided *when*. That decision was left to whatever loop called
 * them, which meant every caller would have re-derived the same schedule from
 * §3 and would eventually have derived it slightly differently.
 *
 * So it lives here, as a pure function of state and instant. A service polls it
 * and performs what it returns; a replay asks it the same questions at the same
 * instants and gets the same answers. There is no clock inside — the caller
 * passes the time it believes it is, and §23.5 makes that the *server's* time,
 * never a device's.
 *
 * This decides sequencing only. Whether a battle is scorable, whether a tick is
 * within the window, whether a round must void for missing data — all of that
 * stays in the engine, which already refuses what it must.
 */

/** The action a round is due for. */
export type RoundAction =
  /** Nothing to do yet. `until` is when to ask again. */
  | { readonly kind: 'WAIT'; readonly until: UtcTimestamp; readonly reason: string }
  /**
   * Accept picks. The phase is open and the engine is already in `PICK_OPEN`;
   * this is the window during which submissions are legal (§3.2).
   */
  | { readonly kind: 'ACCEPT_PICKS'; readonly closesAt: UtcTimestamp }
  /** Lock picks and start the battle (§22 `PICK_OPEN → LOCKING`). */
  | { readonly kind: 'LOCK' }
  /** Score a tick. `deadline` is the hard cutoff after which data is excluded. */
  | { readonly kind: 'TICK'; readonly deadline: UtcTimestamp }
  /** The scoring window has closed; finalize (§22 `BATTLE_LIVE → FINALIZING`). */
  | { readonly kind: 'FINALIZE' }
  /**
   * Finalization has been waiting longer than the policy allows (§25).
   *
   * Not an instruction to void: it is an instruction to stop waiting quietly.
   * §61 principle 19 makes the choice between degrading and voiding a decision
   * about data, and the operator runbook covers it.
   */
  | { readonly kind: 'FINALIZATION_OVERDUE'; readonly waitedFor: DurationMs }
  /** Terminal. `FINALIZED` or `VOID` — nothing further happens to this round. */
  | { readonly kind: 'DONE'; readonly state: RoundState };

/**
 * The round's next action at `now`.
 *
 * @throws RangeError if `now` precedes the round's own Pick Phase opening,
 *   which means the caller is asking about a round that does not exist yet.
 */
export function nextRoundAction(
  state: RoundEngineState,
  now: UtcTimestamp,
  finalizationMaxWait: DurationMs,
): RoundAction {
  if (now < state.clock.pickOpenAt) {
    throw new RangeError(
      `Round ${state.roundId} opens at ${String(state.clock.pickOpenAt)}, asked about ${String(now)}`,
    );
  }

  if (isTerminalRoundState(state.state)) {
    return { kind: 'DONE', state: state.state };
  }

  switch (state.state) {
    case 'PREPARING':
      // The round exists but has not opened its phase. §22 requires the
      // transition to be made explicitly rather than inferred from the clock,
      // so the caller is told to wait and the engine stays authoritative.
      return {
        kind: 'WAIT',
        until: state.clock.pickOpenAt,
        reason: 'Round is prepared and waiting to open its Pick Phase',
      };

    case 'PICK_OPEN':
      // §3.2: one minute, then lock. Picks are accepted right up to the
      // boundary and not a millisecond past it — §72.4 makes the server, not a
      // client countdown, decide whether a submission was in time.
      return now < state.clock.lockAt
        ? { kind: 'ACCEPT_PICKS', closesAt: state.clock.lockAt }
        : { kind: 'LOCK' };

    case 'LOCKING':
      // A mechanical step between two phases. There is nothing to wait for.
      return { kind: 'LOCK' };

    case 'BATTLE_LIVE':
      // §12.6 makes the cutoff hard: data after it is excluded, so the window
      // is never extended to wait for a slow feed.
      return now < state.clock.battleEndAt
        ? { kind: 'TICK', deadline: state.clock.battleEndAt }
        : { kind: 'FINALIZE' };

    case 'FINALIZING': {
      const waited = (now - state.clock.battleEndAt) as DurationMs;
      return waited > finalizationMaxWait
        ? { kind: 'FINALIZATION_OVERDUE', waitedFor: waited }
        : { kind: 'WAIT', until: state.clock.battleEndAt, reason: 'Finalization in progress' };
    }
  }
  // No `default`, and no `FINALIZED` or `VOID` case: the terminal check above
  // is a type guard, so by here TypeScript knows those two are impossible and
  // rejects any attempt to handle them. What remains is exhaustive, which means
  // adding a state to §22's machine fails to compile rather than falling
  // silently into a catch-all.
}

/**
 * Whether the round is inside its final push (§13.5, `FINAL_PUSH_DURATION`).
 *
 * Presentation only. The last thirty seconds are given their own visual
 * treatment, and nothing about scoring changes — a client that dramatised the
 * final push by weighting it would be inventing a rule.
 */
export function isFinalPush(clock: CanonicalClock, now: UtcTimestamp): boolean {
  const pushOpensAt = clock.battleEndAt - FINAL_PUSH_DURATION;
  return now >= pushOpensAt && now < clock.battleEndAt;
}

/**
 * When the next round's Pick Phase opens.
 *
 * §3.1 makes rounds contiguous: one ends and the next begins, so the schedule
 * never drifts. Deriving the next opening from this round's rather than from
 * "now plus ten minutes" is what keeps a slow finalization from pushing every
 * subsequent round late.
 */
export function nextRoundOpensAt(clock: CanonicalClock): UtcTimestamp {
  return clock.battleEndAt;
}

/**
 * How long to sleep before asking again, bounded.
 *
 * A caller that slept exactly until `until` would wake at the boundary and
 * race it. A caller that polled continuously would burn a core. This clamps to
 * a sane window and never returns a negative interval.
 */
export function pollDelay(
  action: RoundAction,
  now: UtcTimestamp,
  maxDelay: DurationMs,
): DurationMs {
  if (action.kind !== 'WAIT') {
    return 0 as DurationMs;
  }
  const remaining = action.until - now;
  if (remaining <= 0) {
    return 0 as DurationMs;
  }
  return (remaining < maxDelay ? remaining : maxDelay) as DurationMs;
}
