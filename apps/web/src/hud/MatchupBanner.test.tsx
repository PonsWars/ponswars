// @vitest-environment jsdom
import { utcTimestamp, type CanonicalClock } from '@ponswars/shared-types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSession, type ClientBattle, type ClientRound } from '../state/session.js';
import { MatchupBanner } from './MatchupBanner.js';

/**
 * The matchup across the top of a battle view (§42.6).
 */

const CLOCK: CanonicalClock = {
  serverTime: utcTimestamp(1_800_000_000_000),
  pickOpenAt: utcTimestamp(1_800_000_000_000),
  lockAt: utcTimestamp(1_800_000_060_000),
  battleStartAt: utcTimestamp(1_800_000_060_000),
  battleEndAt: utcTimestamp(1_800_000_600_000),
};

const round = (state: ClientRound['state']): ClientRound => ({
  roundId: 'round-1',
  state,
  clock: CLOCK,
  nextRoundOpensAt: utcTimestamp(1_800_000_600_000),
  feedHealth: 'HEALTHY',
});

const BATTLE: ClientBattle = {
  battleId: 'battle-1',
  sectorIndex: 0,
  left: 'NVDA',
  right: 'AAPL',
  leftIntel: {
    label: 'FAVORED',
    priceTrend: 'STRONG',
    volumePulse: 'RISING',
    ponsActivity: 'HIGH',
    momentumStability: 'STABLE',
  },
  rightIntel: {
    label: 'UNDERDOG',
    priceTrend: 'MIXED',
    volumePulse: 'NORMAL',
    ponsActivity: 'LOW',
    momentumStability: 'MIXED',
  },
  momentum: 'CONTESTED',
  frontline: 0.5,
  backing: null,
};

afterEach(() => {
  cleanup();
  useSession.setState({ round: null });
});

describe('saying the player is watching', () => {
  it('says SPECTATING once picks are closed and this wallet backed neither side', () => {
    useSession.setState({ round: round('BATTLE_LIVE') });
    render(<MatchupBanner battle={BATTLE} />);

    expect(screen.getByText('SPECTATING')).toBeDefined();
  });

  it('does not say it to a player who backed a side', () => {
    useSession.setState({ round: round('BATTLE_LIVE') });
    render(
      <MatchupBanner battle={{ ...BATTLE, backing: { ticker: 'NVDA', cardDeployed: false } }} />,
    );

    expect(screen.queryByText('SPECTATING')).toBeNull();
  });

  it('does not say it while a side can still be chosen', () => {
    useSession.setState({ round: round('PICK_OPEN') });
    render(<MatchupBanner battle={BATTLE} />);

    expect(screen.queryByText('SPECTATING')).toBeNull();
  });
});
