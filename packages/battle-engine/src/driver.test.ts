import {
  buildCanonicalClock,
  FINAL_PUSH_DURATION,
  milliseconds,
  ROUND_STATES,
  utcTimestamp,
  type RoundState,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  isFinalPush,
  nextRoundAction,
  nextRoundOpensAt,
  pollDelay,
  type RoundAction,
} from './driver.js';
import type { RoundEngineState } from './round.js';

const OPEN_AT = utcTimestamp(1_800_000_000_000);
const CLOCK = buildCanonicalClock(OPEN_AT, OPEN_AT);
const MAX_WAIT = milliseconds(5_000);

/** A round in a given state. Only the fields the driver reads matter here. */
function round(state: RoundState): RoundEngineState {
  return {
    roundId: 'r-1',
    state,
    clock: CLOCK,
    battles: [],
    picks: [],
    matchmakingSeed: '0x00',
  } as unknown as RoundEngineState;
}

const at = (offset: number): UtcTimestamp => utcTimestamp(OPEN_AT + offset);

describe('the pick phase', () => {
  it('accepts picks from the instant it opens', () => {
    const action = nextRoundAction(round('PICK_OPEN'), OPEN_AT, MAX_WAIT);
    expect(action).toEqual<RoundAction>({ kind: 'ACCEPT_PICKS', closesAt: CLOCK.lockAt });
  });

  it('still accepts a pick one millisecond before lock', () => {
    // §72.4 makes the server decide whether a submission was in time, and the
    // boundary it uses is exactly `lockAt`.
    const action = nextRoundAction(round('PICK_OPEN'), utcTimestamp(CLOCK.lockAt - 1), MAX_WAIT);
    expect(action.kind).toBe('ACCEPT_PICKS');
  });

  it('locks at exactly lockAt, not a millisecond later', () => {
    expect(nextRoundAction(round('PICK_OPEN'), CLOCK.lockAt, MAX_WAIT).kind).toBe('LOCK');
  });

  it('locks late rather than reopening, if the loop fell behind', () => {
    // A service that stalled through the whole battle window still has one
    // correct next move, and it is not "accept picks retroactively".
    expect(nextRoundAction(round('PICK_OPEN'), at(9 * 60_000), MAX_WAIT).kind).toBe('LOCK');
  });
});

describe('the battle window', () => {
  it('ticks while the window is open', () => {
    const action = nextRoundAction(round('BATTLE_LIVE'), at(5 * 60_000), MAX_WAIT);
    expect(action).toEqual<RoundAction>({ kind: 'TICK', deadline: CLOCK.battleEndAt });
  });

  it('ticks at the very start of the window', () => {
    expect(nextRoundAction(round('BATTLE_LIVE'), CLOCK.battleStartAt, MAX_WAIT).kind).toBe('TICK');
  });

  it('finalizes at exactly the cutoff', () => {
    // §12.6: the cutoff is hard. The window is never extended for a slow feed,
    // so there is no case where the answer here is "tick once more".
    expect(nextRoundAction(round('BATTLE_LIVE'), CLOCK.battleEndAt, MAX_WAIT).kind).toBe(
      'FINALIZE',
    );
  });

  it('finalizes rather than ticking after the cutoff', () => {
    expect(nextRoundAction(round('BATTLE_LIVE'), at(60 * 60_000), MAX_WAIT).kind).toBe('FINALIZE');
  });
});

describe('finalization', () => {
  it('waits while finalization is in progress', () => {
    const action = nextRoundAction(
      round('FINALIZING'),
      utcTimestamp(CLOCK.battleEndAt + 1),
      MAX_WAIT,
    );
    expect(action.kind).toBe('WAIT');
  });

  it('reports overdue once the policy wait is exceeded', () => {
    const late = utcTimestamp(CLOCK.battleEndAt + MAX_WAIT + 1);
    const action = nextRoundAction(round('FINALIZING'), late, MAX_WAIT);
    expect(action).toEqual<RoundAction>({
      kind: 'FINALIZATION_OVERDUE',
      waitedFor: milliseconds(MAX_WAIT + 1),
    });
  });

  it('does not report overdue at exactly the policy boundary', () => {
    const boundary = utcTimestamp(CLOCK.battleEndAt + MAX_WAIT);
    expect(nextRoundAction(round('FINALIZING'), boundary, MAX_WAIT).kind).toBe('WAIT');
  });

  it('does not instruct a void', () => {
    // Overdue means stop waiting quietly, not void. §61 principle 19 makes the
    // choice between degrading and voiding a decision about data, and the
    // runbook covers it — a scheduler must not make it by timeout.
    const late = utcTimestamp(CLOCK.battleEndAt + MAX_WAIT * 100);
    const action = nextRoundAction(round('FINALIZING'), late, MAX_WAIT);
    expect(action.kind).not.toBe('VOID');
    expect(action.kind).toBe('FINALIZATION_OVERDUE');
  });
});

describe('terminal states', () => {
  it('reports done and nothing else', () => {
    for (const state of ['FINALIZED', 'VOID'] satisfies RoundState[]) {
      const action = nextRoundAction(round(state), at(60 * 60_000), MAX_WAIT);
      expect(action).toEqual<RoundAction>({ kind: 'DONE', state });
    }
  });

  it('stays done however late it is asked', () => {
    expect(nextRoundAction(round('VOID'), at(365 * 24 * 3_600_000), MAX_WAIT).kind).toBe('DONE');
  });
});

describe('coverage of the state machine', () => {
  it('answers for every state §22 defines', () => {
    // A state added to the machine must not fall through to a default here.
    for (const state of ROUND_STATES) {
      const action = nextRoundAction(round(state), at(30_000), MAX_WAIT);
      expect(action.kind.length).toBeGreaterThan(0);
    }
  });

  it('waits for a prepared round rather than opening it by clock', () => {
    // §22 requires the transition to be made explicitly. Inferring it from the
    // time would make the scheduler, not the engine, the authority on state.
    const action = nextRoundAction(round('PREPARING'), at(30_000), MAX_WAIT);
    expect(action.kind).toBe('WAIT');
  });

  it('refuses a question about a round that has not started', () => {
    expect(() => nextRoundAction(round('PICK_OPEN'), utcTimestamp(OPEN_AT - 1), MAX_WAIT)).toThrow(
      RangeError,
    );
  });
});

describe('the final push', () => {
  it('covers the last thirty seconds of the window', () => {
    const opensAt = utcTimestamp(CLOCK.battleEndAt - FINAL_PUSH_DURATION);
    expect(isFinalPush(CLOCK, utcTimestamp(opensAt - 1))).toBe(false);
    expect(isFinalPush(CLOCK, opensAt)).toBe(true);
    expect(isFinalPush(CLOCK, utcTimestamp(CLOCK.battleEndAt - 1))).toBe(true);
  });

  it('ends at the cutoff, not after it', () => {
    expect(isFinalPush(CLOCK, CLOCK.battleEndAt)).toBe(false);
  });
});

describe('round succession', () => {
  it('opens the next round where this one ended', () => {
    // §3.1 makes rounds contiguous. Deriving the next opening from this round's
    // end rather than from "now" is what stops a slow finalization pushing
    // every subsequent round late.
    expect(nextRoundOpensAt(CLOCK)).toBe(CLOCK.battleEndAt);
  });

  it('keeps the schedule exact across many rounds', () => {
    let clock = CLOCK;
    for (let index = 0; index < 144; index += 1) {
      clock = buildCanonicalClock(nextRoundOpensAt(clock), OPEN_AT);
    }
    // 144 ten-minute rounds is exactly one day.
    expect(clock.pickOpenAt).toBe(utcTimestamp(OPEN_AT + 144 * 10 * 60_000));
  });
});

describe('pollDelay', () => {
  it('is zero when there is something to do', () => {
    expect(pollDelay({ kind: 'LOCK' }, OPEN_AT, milliseconds(1_000))).toBe(0);
  });

  it('never exceeds the cap', () => {
    const action: RoundAction = { kind: 'WAIT', until: at(60_000), reason: 'x' };
    expect(pollDelay(action, OPEN_AT, milliseconds(1_000))).toBe(1_000);
  });

  it('shortens to the remaining time near the boundary', () => {
    const action: RoundAction = { kind: 'WAIT', until: at(250), reason: 'x' };
    expect(pollDelay(action, OPEN_AT, milliseconds(1_000))).toBe(250);
  });

  it('never returns a negative delay for a boundary already passed', () => {
    const action: RoundAction = { kind: 'WAIT', until: OPEN_AT, reason: 'x' };
    expect(pollDelay(action, at(5_000), milliseconds(1_000))).toBe(0);
  });
});
