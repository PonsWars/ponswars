import { describe, expect, it } from 'vitest';
import {
  acceptsPickMutation,
  BATTLE_DURATION,
  BATTLE_STATE_TRANSITIONS,
  BATTLE_STATES,
  BATTLES_PER_ROUND,
  buildCanonicalClock,
  canTransitionBattle,
  canTransitionRound,
  displayPhaseAt,
  FINAL_PUSH_DURATION,
  isFinalPush,
  isTerminalRoundState,
  MATCHUP_COOLDOWN_ROUNDS,
  mayRevealExactScore,
  PICK_PHASE_DURATION,
  PICKS_PER_WALLET_PER_ROUND,
  remainingUntil,
  ROUND_DURATION,
  ROUND_STATE_TRANSITIONS,
  ROUND_STATES,
  TERMINAL_ROUND_STATES,
  type RoundState,
} from './round.js';
import { ACTIVE_TICKERS } from './roster.js';
import type { UtcTimestamp } from './time.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offsetMs: number): UtcTimestamp => (T0 + offsetMs) as UtcTimestamp;

describe('locked round timing', () => {
  it('runs exactly ten minutes', () => {
    expect(ROUND_DURATION).toBe(600_000);
  });

  it('opens picks for exactly one minute', () => {
    expect(PICK_PHASE_DURATION).toBe(60_000);
  });

  it('runs the live battle for exactly nine minutes', () => {
    expect(BATTLE_DURATION).toBe(540_000);
  });

  it('accounts for the whole round with no gap or overlap', () => {
    // §3: 00:00-01:00 pick, 01:00-10:00 battle. Any drift here would mean the
    // scoring window and the round boundary disagree.
    expect(PICK_PHASE_DURATION + BATTLE_DURATION).toBe(ROUND_DURATION);
  });

  it('produces one battle for every two active tickers', () => {
    expect(BATTLES_PER_ROUND).toBe(5);
    expect(ACTIVE_TICKERS.length).toBe(BATTLES_PER_ROUND * 2);
  });

  it('allows one pick per wallet per round with a two-round matchup cooldown', () => {
    expect(PICKS_PER_WALLET_PER_ROUND).toBe(1);
    expect(MATCHUP_COOLDOWN_ROUNDS).toBe(2);
    // Two rounds is twenty minutes at the locked round length (§4.3).
    expect(MATCHUP_COOLDOWN_ROUNDS * ROUND_DURATION).toBe(1_200_000);
  });
});

describe('round state machine', () => {
  it('declares a transition list for every state', () => {
    expect(Object.keys(ROUND_STATE_TRANSITIONS).sort()).toEqual([...ROUND_STATES].sort());
  });

  it('follows the locked happy path', () => {
    const path: readonly RoundState[] = [
      'PREPARING',
      'PICK_OPEN',
      'LOCKING',
      'BATTLE_LIVE',
      'FINALIZING',
      'FINALIZED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(canTransitionRound(from!, to!)).toBe(true);
    }
  });

  it('allows VOID from every non-terminal state', () => {
    // §4.4 and §22: an integrity failure can void a round at any live point.
    for (const state of ROUND_STATES) {
      if (isTerminalRoundState(state)) continue;
      expect(canTransitionRound(state, 'VOID')).toBe(true);
    }
  });

  it('never leaves a terminal state', () => {
    // Finalization is exactly-once and a result is immutable (§25, §49.9).
    for (const terminal of TERMINAL_ROUND_STATES) {
      expect(ROUND_STATE_TRANSITIONS[terminal]).toHaveLength(0);
      for (const target of ROUND_STATES) {
        expect(canTransitionRound(terminal, target)).toBe(false);
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const state of ROUND_STATES) {
      expect(canTransitionRound(state, state)).toBe(false);
    }
  });

  it('never skips a step on the happy path', () => {
    expect(canTransitionRound('PICK_OPEN', 'BATTLE_LIVE')).toBe(false);
    expect(canTransitionRound('PREPARING', 'FINALIZED')).toBe(false);
    expect(canTransitionRound('BATTLE_LIVE', 'FINALIZED')).toBe(false);
    expect(canTransitionRound('LOCKING', 'PICK_OPEN')).toBe(false);
  });

  it('reaches every state from PREPARING', () => {
    const seen = new Set<RoundState>(['PREPARING']);
    const queue: RoundState[] = ['PREPARING'];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const next of ROUND_STATE_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(ROUND_STATES.length);
  });
});

describe('mutation and disclosure gates', () => {
  it('accepts pick mutation only during PICK_OPEN', () => {
    for (const state of ROUND_STATES) {
      expect(acceptsPickMutation(state)).toBe(state === 'PICK_OPEN');
    }
  });

  it('reveals the exact score only after finalization', () => {
    // Guide §7.2: three delivered PNGs show a live exact score. This gate is
    // what stops that reading from becoming behaviour.
    for (const state of ROUND_STATES) {
      expect(mayRevealExactScore(state)).toBe(state === 'FINALIZED');
    }
    expect(mayRevealExactScore('BATTLE_LIVE')).toBe(false);
  });
});

describe('battle state machine', () => {
  it('declares a transition list for every state', () => {
    expect(Object.keys(BATTLE_STATE_TRANSITIONS).sort()).toEqual([...BATTLE_STATES].sort());
  });

  it('runs scheduled to live to finalized', () => {
    expect(canTransitionBattle('SCHEDULED', 'LIVE')).toBe(true);
    expect(canTransitionBattle('LIVE', 'FINALIZED')).toBe(true);
  });

  it('can void before or during the battle but never after finalization', () => {
    expect(canTransitionBattle('SCHEDULED', 'VOID')).toBe(true);
    expect(canTransitionBattle('LIVE', 'VOID')).toBe(true);
    expect(canTransitionBattle('FINALIZED', 'VOID')).toBe(false);
  });

  it('never leaves a terminal state', () => {
    expect(BATTLE_STATE_TRANSITIONS.FINALIZED).toHaveLength(0);
    expect(BATTLE_STATE_TRANSITIONS.VOID).toHaveLength(0);
  });
});

describe('canonical clock', () => {
  const clock = buildCanonicalClock(T0, at(5_000));

  it('derives lock at one minute and cutoff at ten', () => {
    expect(clock.pickOpenAt).toBe(T0);
    expect(clock.lockAt).toBe(T0 + 60_000);
    expect(clock.battleEndAt).toBe(T0 + 600_000);
  });

  it('opens the scoring window exactly at lock', () => {
    // §12.1 — the same instant, named separately because they mean different
    // things. Any drift between them would silently change the score window.
    expect(clock.battleStartAt).toBe(clock.lockAt);
  });

  it('carries the server time it was built with', () => {
    expect(clock.serverTime).toBe(T0 + 5_000);
  });

  it('spans exactly the battle duration between start and cutoff', () => {
    expect(clock.battleEndAt - clock.battleStartAt).toBe(BATTLE_DURATION);
  });
});

describe('display phase', () => {
  const clock = buildCanonicalClock(T0, T0);

  it.each([
    [-1, 'BEFORE_ROUND'],
    [0, 'PICK_OPEN'],
    [59_999, 'PICK_OPEN'],
    [60_000, 'BATTLE_LIVE'],
    [599_999, 'BATTLE_LIVE'],
    [600_000, 'AFTER_CUTOFF'],
    [700_000, 'AFTER_CUTOFF'],
  ])('at %sms reads %s', (offset, expected) => {
    expect(displayPhaseAt(clock, at(offset))).toBe(expected);
  });

  it('treats the lock instant as battle rather than pick', () => {
    // §3.2 locks *at* 01:00, so the boundary instant is already closed to input.
    expect(displayPhaseAt(clock, clock.lockAt)).toBe('BATTLE_LIVE');
  });

  it('treats the cutoff instant as past the window', () => {
    // §12.6: data at or after the cutoff is excluded.
    expect(displayPhaseAt(clock, clock.battleEndAt)).toBe('AFTER_CUTOFF');
  });
});

describe('countdown', () => {
  it('counts down to a future target', () => {
    expect(remainingUntil(at(0), at(1_000))).toBe(1_000);
  });

  it('floors at zero rather than going negative', () => {
    // A client clock running ahead of the server must not render -3s.
    expect(remainingUntil(at(1_000), at(0))).toBe(0);
    expect(remainingUntil(at(0), at(0))).toBe(0);
  });
});

describe('final push window', () => {
  const clock = buildCanonicalClock(T0, T0);

  it('lasts the last thirty seconds of the battle', () => {
    expect(FINAL_PUSH_DURATION).toBe(30_000);
    expect(isFinalPush(clock, at(600_000 - 30_000))).toBe(true);
    expect(isFinalPush(clock, at(599_999))).toBe(true);
  });

  it('is not active earlier in the battle', () => {
    expect(isFinalPush(clock, at(600_000 - 30_001))).toBe(false);
    expect(isFinalPush(clock, at(60_000))).toBe(false);
  });

  it('is not active during pick phase or after the cutoff', () => {
    expect(isFinalPush(clock, at(0))).toBe(false);
    expect(isFinalPush(clock, at(600_000))).toBe(false);
    expect(isFinalPush(clock, at(700_000))).toBe(false);
  });
});
