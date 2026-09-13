import type { Profile } from '@ponswars/schemas';
import { CARD_CATALOG } from '@ponswars/shared-types';
import { cardEffectLine } from '../art/GenesisCardFace.js';
import { formatTokenAmount } from '../presentation/token-amount.js';
import type { Holdings, ProfileData, WarHoldingView } from './WarRoom.js';

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
    holdings: {
      war: warHoldingFrom(profile.holdings.war),
      genesis: genesisHoldingFrom(profile.holdings.genesis),
    },
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
 * The server's Genesis card, as the war room shows it (§34.2).
 *
 * A server that deals no cards says so, and the war room shows that rather than
 * an unclaimed card — which would be a statement about this wallet nothing had
 * checked.
 */
export function genesisHoldingFrom(genesis: Profile['holdings']['genesis']): Holdings['genesis'] {
  if (genesis.status === 'UNPUBLISHED') {
    return { status: 'UNPUBLISHED' };
  }
  const { card } = genesis;
  return {
    status: 'PUBLISHED',
    card:
      card === null
        ? null
        : {
            genesisId: card.genesisId,
            name: CARD_CATALOG[card.cardType].name,
            rarity: card.rarity,
            cardType: card.cardType,
            effect: cardEffectLine(card.cardType),
            usesRemaining: card.remainingUses,
            // Secret results are not dealt yet (§8.4); when they are, the
            // trophy is the card's rarity rather than a separate claim.
            secretTrophy: card.rarity === 'SECRET',
          },
  };
}

/** The server's `$WAR` holding, written down. Holder status is any balance at all. */
export function warHoldingFrom(war: Profile['holdings']['war']): WarHoldingView {
  return war.status === 'READ'
    ? {
        status: 'READ',
        balance: formatTokenAmount(war.balance, war.decimals),
        holder: war.balance !== '0',
      }
    : { status: war.status };
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
