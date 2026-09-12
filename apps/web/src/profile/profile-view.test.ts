import type { Profile } from '@ponswars/schemas';
import { describe, expect, it } from 'vitest';
import { roundLabel, warRoomFrom } from './profile-view.js';

/**
 * The server's profile, written down for the war room.
 *
 * Formatting only — so what these check is that nothing is decided here: no
 * outcome reclassified, no rate recomputed, and nothing about the chain stated
 * as a fact.
 */

const PROFILE: Profile = {
  wallet: '0x4f2a00000000000000000000000000000000c9c1',
  lifetime: {
    battles: 3,
    wins: 2,
    losses: 1,
    winRateBps: 6_666,
    upsets: 1,
    majorUpsets: 1,
    cardAssistedWins: 1,
    warPoints: 26,
  },
  currentWindow: { warPoints: 26, qualified: false, weight: '5099019513', window: null },
  history: [
    {
      roundId: 'round-0000000412',
      battleId: 'round-0000000412-b1',
      left: 'GME',
      right: 'TSLA',
      backed: 'GME',
      outcome: 'MAJOR_UPSET',
      warPoints: 16,
      cardDeployed: true,
      settledAt: 1_800_000_000_000,
    },
    {
      roundId: 'round-0000000411',
      battleId: 'round-0000000411-b4',
      left: 'AMD',
      right: 'META',
      backed: 'META',
      outcome: 'LOSS',
      warPoints: 0,
      cardDeployed: false,
      settledAt: 1_799_999_400_000,
    },
  ],
  mostBacked: { ticker: 'GME', battles: 2, winRateBps: 10_000 },
  biggestUpset: {
    roundId: 'round-0000000412',
    winner: 'GME',
    loser: 'TSLA',
    outcome: 'MAJOR_UPSET',
  },
  holdings: { status: 'UNPUBLISHED' },
};

describe('the war room, from a live profile', () => {
  const room = warRoomFrom(PROFILE);

  it('shortens the wallet the way the rest of the product does', () => {
    expect(room.addressFragment).toBe('0x4f2…9c1');
  });

  it('says the chain holdings are unpublished rather than empty', () => {
    // A zero balance and an unclaimed card would both be statements about this
    // wallet that nothing has checked.
    expect(room.holdings).toEqual({ status: 'UNPUBLISHED' });
  });

  it('carries the server’s figures unchanged', () => {
    expect(room.lifetime).toEqual({
      battles: 3,
      wins: 2,
      losses: 1,
      winRateBps: 6_666,
      upsets: 1,
      majorUpsets: 1,
      cardAssistedWins: 1,
      lifetimeWarPoints: 26,
    });
    expect(room.mostBacked).toEqual(PROFILE.mostBacked);
  });

  it('writes each battle down without reclassifying it', () => {
    expect(room.history).toEqual([
      {
        roundId: '412',
        matchup: 'GME VS TSLA',
        backed: 'GME',
        outcome: 'MAJOR_UPSET',
        warPoints: 16,
        cardName: 'DEPLOYED',
      },
      {
        roundId: '411',
        matchup: 'AMD VS META',
        backed: 'META',
        outcome: 'LOSS',
        warPoints: 0,
        cardName: null,
      },
    ]);
  });

  it('headlines the biggest upset', () => {
    expect(room.biggestUpset).toEqual({
      headline: 'GME OVER TSLA',
      classification: 'MAJOR UPSET',
      roundId: '412',
    });
  });

  it('has no rate for a wallet that has not played, rather than a rate of zero', () => {
    const fresh = warRoomFrom({
      ...PROFILE,
      lifetime: { ...PROFILE.lifetime, battles: 0, wins: 0, losses: 0, winRateBps: null },
      history: [],
      mostBacked: null,
      biggestUpset: null,
    });

    expect(fresh.lifetime.winRateBps).toBeNull();
    expect(fresh.mostBacked).toBeNull();
    expect(fresh.biggestUpset).toBeNull();
  });
});

describe('a round label', () => {
  it('reads a round identifier as its number', () => {
    expect(roundLabel('round-0000000412')).toBe('412');
    expect(roundLabel('round-0000000000')).toBe('0');
  });

  it('shows anything else as it is, rather than guessing', () => {
    expect(roundLabel('preview-round')).toBe('preview-round');
  });
});
