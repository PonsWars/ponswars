// @vitest-environment jsdom
import { utcTimestamp, type CanonicalClock } from '@ponswars/shared-types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession, type ClientRound } from '../state/session.js';
import { Countdown, RoundStatus } from './RoundStatus.js';

/**
 * What the HUD says about the round (§22, §13.5, §42.14).
 *
 * Rendered rather than derived: `round-phase.ts` is tested on its own, and
 * this is about what a player actually sees — including the one thing a pure
 * test could not catch, that the `FINAL PUSH` label reached the levels where
 * the round panel is not shown at all.
 */

const CLOCK: CanonicalClock = {
  serverTime: utcTimestamp(1_800_000_000_000),
  pickOpenAt: utcTimestamp(1_800_000_000_000),
  lockAt: utcTimestamp(1_800_000_060_000),
  battleStartAt: utcTimestamp(1_800_000_060_000),
  battleEndAt: utcTimestamp(1_800_000_600_000),
};

const ROUND: ClientRound = {
  roundId: 'round-1',
  state: 'BATTLE_LIVE',
  clock: CLOCK,
  nextRoundOpensAt: utcTimestamp(1_800_000_600_000),
  feedHealth: 'HEALTHY',
};

/** Puts the device clock at an instant inside the round. */
function at(instant: number): void {
  vi.setSystemTime(instant);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useSession.setState({ round: null, clockOffsetMs: 0, myBattleId: null, lastVoids: {} });
});

describe('the round panel', () => {
  it('says it is syncing before the first round arrives (§42.14)', () => {
    // A useful sync state, never a fabricated phase.
    render(<RoundStatus />);

    expect(screen.getByText('SYNCING')).toBeDefined();
  });

  it('says FINAL PUSH in the last thirty seconds (§13.5)', () => {
    at(CLOCK.battleEndAt - 20_000);
    useSession.setState({ round: ROUND });

    render(<RoundStatus />);

    expect(screen.getByText('FINAL PUSH')).toBeDefined();
  });

  it('does not say it a minute out', () => {
    at(CLOCK.battleEndAt - 60_000);
    useSession.setState({ round: ROUND });

    render(<RoundStatus />);

    expect(screen.queryByText('FINAL PUSH')).toBeNull();
  });

  it("reads the round's clock through the server offset, never the device (§23.5)", () => {
    // A device four minutes fast must see the same phase as everybody else.
    at(CLOCK.battleEndAt - 260_000);
    useSession.setState({ round: ROUND, clockOffsetMs: 240_000 });

    render(<RoundStatus />);

    expect(screen.getByText('FINAL PUSH')).toBeDefined();
  });
});

describe('the countdown', () => {
  it('carries the FINAL PUSH label where the round panel is not shown (§37.6)', () => {
    // Inside a sector and on a battlefield the countdown is all the HUD has of
    // the round, and those are the levels a player watches the end from.
    at(CLOCK.battleEndAt - 20_000);
    useSession.setState({ round: ROUND });

    render(<Countdown namesFinalPush />);

    expect(screen.getByText('FINAL PUSH')).toBeDefined();
  });

  it('leaves it to the round panel at the global view', () => {
    at(CLOCK.battleEndAt - 20_000);
    useSession.setState({ round: ROUND });

    render(<Countdown />);

    expect(screen.queryByText('FINAL PUSH')).toBeNull();
    expect(screen.getByText('BATTLE ENDS')).toBeDefined();
  });

  it('shows the time left, and nothing that is not on the wire (§24)', () => {
    at(CLOCK.battleEndAt - 95_000);
    useSession.setState({ round: ROUND });

    render(<Countdown />);

    expect(screen.getByText('01:35')).toBeDefined();
  });
});
