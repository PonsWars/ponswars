import type { GenesisStatusBody } from '@ponswars/schemas';
import { CARD_CATALOG } from '@ponswars/shared-types';
import { cardEffectLine } from '../art/GenesisCardFace.js';
import { formatTokenAmount } from '../presentation/token-amount.js';
import type { GenesisOutcome } from './GenesisReveal.js';

/**
 * The Genesis page, from where the server says a claim has got to (§27.2, §69.6).
 *
 * Formatting only: eligibility, the block and the card are all the server's.
 */
export type GenesisView =
  /** This server reads no chain and cannot deal a card. */
  | { readonly kind: 'UNPUBLISHED' }
  /** Never asked: the page offers the one request this wallet will get. */
  | { readonly kind: 'OFFER' }
  /** §6: under a million `$WAR` right now. */
  | { readonly kind: 'NOT_ELIGIBLE'; readonly balance: string; readonly threshold: string }
  /** Bound to a Robinhood Chain block that is not finalized yet. */
  | { readonly kind: 'SEALING'; readonly targetBlock: number }
  /** §76.5: a Secret waiting on its reservation. Nothing about the card is known here. */
  | { readonly kind: 'RESERVING' }
  | { readonly kind: 'CARD'; readonly outcome: GenesisOutcome };

export function genesisViewFrom(body: GenesisStatusBody): GenesisView {
  switch (body.status) {
    case 'UNPUBLISHED':
      return { kind: 'UNPUBLISHED' };
    case 'NONE':
      return { kind: 'OFFER' };
    case 'NOT_ELIGIBLE_BALANCE':
      return {
        kind: 'NOT_ELIGIBLE',
        balance: formatTokenAmount(body.balance, body.decimals),
        threshold: formatTokenAmount(body.threshold, body.decimals),
      };
    case 'PENDING_FINALITY':
      return { kind: 'SEALING', targetBlock: body.targetBlock };
    case 'SECRET_RESERVATION_PENDING':
      return { kind: 'RESERVING' };
    case 'READY':
    case 'ALREADY_CLAIMED': {
      const { claim } = body;
      return {
        kind: 'CARD',
        outcome: {
          genesisId: claim.genesisId,
          rarity: claim.rarity,
          cardType: claim.cardType,
          cardName: CARD_CATALOG[claim.cardType].name,
          effect: cardEffectLine(claim.cardType),
          // A claim is only recorded once a Secret's reward is reserved
          // (§76.5), so any card the server hands back is secured.
          secretReservationSecured: true,
        },
      };
    }
  }
}
