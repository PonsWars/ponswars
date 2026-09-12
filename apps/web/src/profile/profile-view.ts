import type { Profile } from '@ponswars/schemas';
import type { ProfileData } from './WarRoom.js';

/**
 * The server's profile, as the war room shows it (§34, §69.9).
 *
 * Formatting only. Every figure is the server's — the win rate arrives in
 * basis points, the outcome already classified — so nothing here decides what
 * happened; it decides how to write it down.
 */
export function warRoomFrom(profile: Profile): ProfileData {
  return {
    addressFragment: `${profile.wallet.slice(0, 5)}…${profile.wallet.slice(-3)}`,
    // Balance, holder status and the card are the chain's, and the server says
    // it has not read them. The war room shows that, rather than a zero balance
    // and an unclaimed card that would both be statements about this wallet.
    holdings: { status: 'UNPUBLISHED' },
    lifetime: {
      battles: profile.lifetime.battles,
      wins: profile.lifetime.wins,
      losses: profile.lifetime.losses,
      winRateBps: profile.lifetime.winRateBps,
      upsets: profile.lifetime.upsets,
      majorUpsets: profile.lifetime.majorUpsets,
      cardAssistedWins: profile.lifetime.cardAssistedWins,
      lifetimeWarPoints: profile.lifetime.warPoints,
    },
    history: profile.history.map((entry) => ({
      roundId: roundLabel(entry.roundId),
      matchup: `${entry.left} VS ${entry.right}`,
      backed: entry.backed,
      outcome: entry.outcome,
      warPoints: entry.warPoints,
      // Which card is the chain's to say; that one was deployed is the record's.
      cardName: entry.cardDeployed ? 'DEPLOYED' : null,
    })),
    mostBacked: profile.mostBacked,
    biggestUpset:
      profile.biggestUpset === null
        ? null
        : {
            headline: `${profile.biggestUpset.winner} OVER ${profile.biggestUpset.loser}`,
            classification: profile.biggestUpset.outcome.replaceAll('_', ' '),
            roundId: roundLabel(profile.biggestUpset.roundId),
          },
  };
}

/**
 * A round identifier as a player reads it: `round-0000000412` is round `412`.
 *
 * Anything that is not in that shape is shown as it is, rather than guessed at.
 */
export function roundLabel(roundId: string): string {
  const match = /^round-(\d+)$/.exec(roundId);
  return match?.[1] === undefined ? roundId : String(Number(match[1]));
}
