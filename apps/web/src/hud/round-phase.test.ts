import {
  ROUND_STATES,
  utcTimestamp,
  type CanonicalClock,
  type RoundState,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATES,
  connectionBanner,
  formatCountdown,
  formatOpensAt,
  roundView,
  voidNotice,
} from './round-phase.js';

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

describe('formatOpensAt', () => {
  it('names the weekday and a 24-hour time in the zone asked for', () => {
    // Sunday 2026-09-20 20:00 in New York, when the market reopens.
    const reopens = Date.parse('2026-09-21T00:00:00Z');
    expect(formatOpensAt(reopens, 'en-US', 'America/New_York')).toBe('SUN 20:00');
    expect(formatOpensAt(reopens, 'en-US', 'UTC')).toBe('MON 00:00');
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

describe('what a player is told when their battle voided', () => {
  it('says why, that the charge came back, and that nothing was lost', () => {
    // §110.6 fixes the middle sentence and §110.5 asks every error to say
    // whether anything is at stake. A void costs a round and nothing else, and
    // the player who spent a Genesis charge on it needs that said out loud.
    expect(voidNotice({ reason: 'DATA_INTEGRITY', cardUseRestored: true })).toEqual([
      'BATTLE VOID — Data integrity threshold was not met.',
      'Your deployed card use has been restored.',
      'No War Points were awarded, and nothing was lost.',
    ]);
  });

  it('does not promise a refund the server did not make', () => {
    // The flag is the server's answer. A player who deployed no card has
    // nothing to get back, and printing the sentence anyway would turn §110.6
    // from a fact into a slogan.
    expect(voidNotice({ reason: 'DATA_INTEGRITY', cardUseRestored: false })).not.toContain(
      'Your deployed card use has been restored.',
    );
  });

  it('tells a halted market from a broken feed', () => {
    // §23.8: a halt is not ordinary flat price action, and a player told
    // "data integrity" about a market that stopped trading would be told
    // something untrue about their own battle.
    expect(voidNotice({ reason: 'MARKET_HALT', cardUseRestored: false })[0]).toContain(
      'market halted',
    );
  });
});
