import {
  ROUND_STATES,
  utcTimestamp,
  type CanonicalClock,
  type RoundState,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { CONNECTION_STATES, connectionBanner, formatCountdown, roundView } from './round-phase.js';

const CLOCK: CanonicalClock = {
  serverTime: utcTimestamp(1_800_000_000_000),
  pickOpenAt: utcTimestamp(1_800_000_000_000),
  lockAt: utcTimestamp(1_800_000_060_000),
  battleStartAt: utcTimestamp(1_800_000_060_000),
  battleEndAt: utcTimestamp(1_800_000_600_000),
};

describe('roundView', () => {
  it('answers for every state in the machine', () => {
    // §22 has seven states and a `VOID` branch out of each non-terminal one.
    // A missing case here would surface as a HUD that renders nothing at the
    // exact moment something went wrong.
    for (const state of ROUND_STATES) {
      const view = roundView(state, CLOCK);
      expect(view.label.length).toBeGreaterThan(0);
    }
  });

  it('allows picks only while the pick phase is open', () => {
    const allowed = ROUND_STATES.filter((state) => roundView(state, CLOCK).picksAllowed);
    expect(allowed).toEqual(['PICK_OPEN']);
  });

  it('counts down to lock during the pick phase', () => {
    const view = roundView('PICK_OPEN', CLOCK);
    expect(view.countdownCaption).toBe('LOCKS IN');
    expect(view.countdownTarget).toBe(CLOCK.lockAt);
  });

  it('counts down to the scoring cutoff once the battle is live', () => {
    const view = roundView('BATTLE_LIVE', CLOCK);
    expect(view.countdownTarget).toBe(CLOCK.battleEndAt);
  });

  it('offers no countdown where the wait has no deadline', () => {
    // Finalization is exactly-once and takes as long as it takes (§25). A timer
    // there would be a guess presented to the player as a deadline.
    for (const state of ['LOCKING', 'FINALIZING', 'FINALIZED', 'VOID'] satisfies RoundState[]) {
      const view = roundView(state, CLOCK);
      expect(view.countdownTarget).toBeNull();
      expect(view.countdownCaption).toBeNull();
    }
  });

  it('names a void round rather than softening it', () => {
    const view = roundView('VOID', CLOCK);
    expect(view.voided).toBe(true);
    expect(view.label).toBe('ROUND VOID');
    // Nothing that reads as "still coming": §4.4 never revives a voided round.
    expect(view.countdownTarget).toBeNull();
  });

  it('marks only VOID as voided', () => {
    const voided = ROUND_STATES.filter((state) => roundView(state, CLOCK).voided);
    expect(voided).toEqual(['VOID']);
  });
});

describe('formatCountdown', () => {
  it('formats minutes and seconds with a leading zero', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(9_000)).toBe('00:09');
    expect(formatCountdown(60_000)).toBe('01:00');
    expect(formatCountdown(599_000)).toBe('09:59');
  });

  it('truncates rather than rounds, so it never shows a second that has not elapsed', () => {
    expect(formatCountdown(9_999)).toBe('00:09');
  });

  it('clamps a passed deadline to zero instead of counting upward', () => {
    // A negative countdown shows an expired deadline as though it were still
    // ahead. Past a lock, `00:00` is the honest reading until the next state
    // arrives.
    expect(formatCountdown(-1)).toBe('00:00');
    expect(formatCountdown(-90_000)).toBe('00:00');
  });

  it('does not cap minutes at the round length', () => {
    // §3.1 makes a round ten minutes, but a client should show what the server
    // told it rather than a capped number that quietly disagrees.
    expect(formatCountdown(3_600_000)).toBe('60:00');
  });
});

describe('connectionBanner', () => {
  it('says nothing while connected', () => {
    expect(connectionBanner('CONNECTED')).toBeNull();
  });

  it('speaks up for every state that is not connected', () => {
    for (const state of CONNECTION_STATES) {
      const banner = connectionBanner(state);
      if (state === 'CONNECTED') {
        expect(banner).toBeNull();
      } else {
        expect(banner).not.toBeNull();
      }
    }
  });
});
