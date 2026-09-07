import {
  addDuration,
  minutes,
  type CanonicalClock,
  type DurationMs,
  type UtcTimestamp,
} from './time.js';

/**
 * Round lifecycle and timing.
 *
 * Masterplan §3 (timing), §4.3 (matchmaking), §22 (state machine).
 * Kickoff Brief §4: *"State machine is mandatory. Never infer state from
 * frontend timer alone."*
 */

// ---------------------------------------------------------------------------
// Timing — LOCKED (§3)
// ---------------------------------------------------------------------------

/** Every global round lasts exactly ten minutes (§3). */
export const ROUND_DURATION: DurationMs = minutes(10);

/** Pick Phase runs 00:00–01:00 and is the only window that accepts input (§3.1). */
export const PICK_PHASE_DURATION: DurationMs = minutes(1);

/**
 * Live battle runs 01:00–10:00 (§3.3).
 *
 * The scoring window opens exactly at lock, so this is also the length of the
 * battle-score window (§12.1).
 */
export const BATTLE_DURATION: DurationMs = minutes(9);

/** Ten active stocks produce exactly five simultaneous battles (§4.3). */
export const BATTLES_PER_ROUND = 5;

/** A user backs one battle and one side per round (§4.3, §5). */
export const PICKS_PER_WALLET_PER_ROUND = 1;

/**
 * The same unordered matchup cannot reappear for two rounds — twenty minutes
 * at the locked round length (§4.3).
 */
export const MATCHUP_COOLDOWN_ROUNDS = 2;

// ---------------------------------------------------------------------------
// Round state machine — LOCKED (§22)
// ---------------------------------------------------------------------------

/**
 * `PREPARING → PICK_OPEN → LOCKING → BATTLE_LIVE → FINALIZING → FINALIZED`,
 * with a `VOID` failure branch out of every non-terminal state (§22).
 */
export const ROUND_STATES = [
  'PREPARING',
  'PICK_OPEN',
  'LOCKING',
  'BATTLE_LIVE',
  'FINALIZING',
  'FINALIZED',
  'VOID',
] as const;

export type RoundState = (typeof ROUND_STATES)[number];

/**
 * States from which no further transition is legal.
 *
 * `FINALIZED` is terminal because finalization is exactly-once and a battle
 * result is immutable afterwards (§25, §49.9). `VOID` is terminal because a
 * voided round is never revived — the next round simply begins (§4.4).
 */
export const TERMINAL_ROUND_STATES = ['FINALIZED', 'VOID'] as const satisfies readonly RoundState[];

export type TerminalRoundState = (typeof TERMINAL_ROUND_STATES)[number];

/**
 * The complete legal transition graph.
 *
 * Declared as data rather than scattered `if` statements so the engine, the
 * replay tool and the tests all read the same rules, and so an illegal
 * transition is a lookup failure instead of a missing branch.
 */
export const ROUND_STATE_TRANSITIONS: Readonly<Record<RoundState, readonly RoundState[]>> = {
  PREPARING: ['PICK_OPEN', 'VOID'],
  PICK_OPEN: ['LOCKING', 'VOID'],
  LOCKING: ['BATTLE_LIVE', 'VOID'],
  BATTLE_LIVE: ['FINALIZING', 'VOID'],
  FINALIZING: ['FINALIZED', 'VOID'],
  FINALIZED: [],
  VOID: [],
} as const;

/** True when `to` is a legal successor of `from`. */
export function canTransitionRound(from: RoundState, to: RoundState): boolean {
  return ROUND_STATE_TRANSITIONS[from].includes(to);
}

/** True when no further transition is legal from `state`. */
export function isTerminalRoundState(state: RoundState): state is TerminalRoundState {
  return (TERMINAL_ROUND_STATES as readonly RoundState[]).includes(state);
}

/**
 * True only during `PICK_OPEN`.
 *
 * §22: picks and card decisions mutate only while the round is `PICK_OPEN`.
 * Every pick and card-decision handler gates on this — never on a clock
 * comparison, and never on a value the client supplied.
 */
export function acceptsPickMutation(state: RoundState): boolean {
  return state === 'PICK_OPEN';
}

/**
 * True once the exact battle score may be revealed.
 *
 * §12.5 and §27.7 keep the internal score hidden for the whole live battle;
 * §12.6 reveals the component breakdown only after finalization. Guide §7.2
 * lists exposing a live score as a mockup error to correct, and three of the
 * delivered PNGs contain one.
 */
export function mayRevealExactScore(state: RoundState): boolean {
  return state === 'FINALIZED';
}

// ---------------------------------------------------------------------------
// Battle state
// ---------------------------------------------------------------------------

/**
 * Per-battle lifecycle.
 *
 * `FINALIZED` and `VOID` are named by the masterplan (§12.6, §4.4).
 * `SCHEDULED` and `LIVE` mirror the surrounding round phases and exist because
 * a battle row needs a state before and during the scoring window (§49.7);
 * they carry no product rule of their own.
 */
export const BATTLE_STATES = ['SCHEDULED', 'LIVE', 'FINALIZED', 'VOID'] as const;

export type BattleState = (typeof BATTLE_STATES)[number];

export const BATTLE_STATE_TRANSITIONS: Readonly<Record<BattleState, readonly BattleState[]>> = {
  SCHEDULED: ['LIVE', 'VOID'],
  LIVE: ['FINALIZED', 'VOID'],
  FINALIZED: [],
  VOID: [],
} as const;

/** True when `to` is a legal successor of `from`. */
export function canTransitionBattle(from: BattleState, to: BattleState): boolean {
  return BATTLE_STATE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Clock derivation
// ---------------------------------------------------------------------------

/**
 * Builds the canonical clock for a round from its Pick Phase opening.
 *
 * Every downstream timestamp is derived here rather than computed separately by
 * each service, so `lockAt` cannot drift between the engine, the API and the
 * gateway.
 */
export function buildCanonicalClock(
  pickOpenAt: UtcTimestamp,
  serverTime: UtcTimestamp,
): CanonicalClock {
  const lockAt = addDuration(pickOpenAt, PICK_PHASE_DURATION);
  return {
    serverTime,
    pickOpenAt,
    lockAt,
    // The scoring window opens exactly at lock (§12.1) — these are the same
    // instant, named separately because they mean different things.
    battleStartAt: lockAt,
    battleEndAt: addDuration(pickOpenAt, ROUND_DURATION),
  };
}

/**
 * Presentation phase a client should render for a given instant.
 *
 * **Display only.** The authoritative state is whatever the Battle Engine says
 * it is; Kickoff Brief §4 forbids inferring state from a frontend timer, and
 * §23.5 makes client clocks non-authoritative. A client uses this to draw a
 * countdown between server events, never to decide that picks have closed.
 */
export type DisplayPhase = 'BEFORE_ROUND' | 'PICK_OPEN' | 'BATTLE_LIVE' | 'AFTER_CUTOFF';

export function displayPhaseAt(clock: CanonicalClock, at: UtcTimestamp): DisplayPhase {
  if (at < clock.pickOpenAt) return 'BEFORE_ROUND';
  if (at < clock.lockAt) return 'PICK_OPEN';
  if (at < clock.battleEndAt) return 'BATTLE_LIVE';
  return 'AFTER_CUTOFF';
}

/**
 * Milliseconds remaining until `target`, floored at zero.
 *
 * Never returns a negative value: a countdown that has run out reads `0`, and
 * a client whose clock is ahead of the server does not render a negative timer.
 */
export function remainingUntil(at: UtcTimestamp, target: UtcTimestamp): DurationMs {
  const remaining = target - at;
  return (remaining > 0 ? remaining : 0) as DurationMs;
}

/**
 * The last thirty seconds of a battle, when the world raises intensity and the
 * client shows `FINAL PUSH` (§13.5).
 *
 * Cosmetic only. No gameplay multiplier is applied, and the winner is not
 * declared until the backend emits `ROUND_FINALIZED`.
 */
export const FINAL_PUSH_DURATION: DurationMs = (30 * 1_000) as DurationMs;

export function isFinalPush(clock: CanonicalClock, at: UtcTimestamp): boolean {
  return (
    at >= clock.battleStartAt &&
    at < clock.battleEndAt &&
    clock.battleEndAt - at <= FINAL_PUSH_DURATION
  );
}
