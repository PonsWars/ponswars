import {
  CARD_CATALOG,
  CARD_TYPES,
  RARITIES,
  type CardType,
  type Rarity,
} from '@ponswars/shared-types';
import { cardEffectLine } from '../art/GenesisCardFace.js';

/**
 * The card pool, as a reader can be shown it (§7.2, §15, §40).
 *
 * The Genesis page had one panel on it and half a screen of nothing below —
 * which reads as a page that failed to load rather than as a page that has
 * said what it has to say. What belongs in that space is the thing the page is
 * about: what a Genesis Card can be.
 *
 * Every word of it is read from `CARD_CATALOG`, which §7.2 locks. Nothing here
 * is written down a second time — a ladder with its own copy of the pool would
 * drift from the engine the first time a card changed, and a page that
 * disagrees with the scoring is worse than a page that says nothing.
 */

export interface LadderCard {
  readonly type: CardType;
  readonly name: string;
  /** What it contributes, in the words the card face uses. */
  readonly effect: string;
}

export interface LadderRung {
  readonly rarity: Rarity;
  readonly cards: readonly LadderCard[];
}

/**
 * The pool by rarity, rarest last, in the order §7.2 lists them.
 *
 * A rarity with no card in the catalog is left out rather than shown empty:
 * the ladder is a description of what exists.
 */
export function cardLadder(): readonly LadderRung[] {
  return RARITIES.map((rarity) => ({
    rarity,
    cards: CARD_TYPES.filter((type) => CARD_CATALOG[type].rarity === rarity).map((type) => ({
      type,
      name: CARD_CATALOG[type].name,
      effect: cardEffectLine(type),
    })),
  })).filter((rung) => rung.cards.length > 0);
}
