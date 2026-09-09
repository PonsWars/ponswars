import type { CardType } from '@ponswars/shared-types';

/**
 * Where the delivered art lives, by what it depicts.
 *
 * A map from a domain value to a file, so nothing composes a path from a string
 * at the point of use. A component that built `/art/faction-${ticker}.webp`
 * would compile, ship, and 404 for every faction whose file is named after its
 * legion rather than its ticker — which is all of them.
 *
 * The files under `apps/web/public/art` are the web build of the masters, made
 * by `tools/build-art.mjs`. The masters are 2–3 MB PNGs and are not in this
 * repository; these are WebP at the size each image is actually shown.
 *
 * There is no faction art here, and the omission is deliberate. Eight of the
 * ten delivered faction dossiers carry the real corporate mark of the company
 * behind the ticker; §7.10 warns those are shorthand in concept art and *"not
 * cleared production assets"*. Only NVDA and SPY carry original emblems, and
 * art for two factions out of ten is not a faction art system — so a faction
 * reads through its accent, its ticker and its legion name until original
 * emblems exist for all ten.
 *
 * The card art has no such problem: original emblem, original units, no
 * third-party mark anywhere.
 */

/**
 * Card art, for the three cards that have any.
 *
 * `Partial`, and deliberately so: §7 has a catalog of cards and three of them
 * were drawn. A record claiming every card had art would make a missing file a
 * broken image at the moment a player opens a Genesis reveal, which is the one
 * moment §40.6 asks to feel like a reveal.
 */
export const CARD_ART: Readonly<Partial<Record<CardType, string>>> = {
  REINFORCEMENT: '/art/card-common_reinforcement.webp',
  GOLDEN_ARMY: '/art/card-legendary_golden_army.webp',
  SECRET_STOCK_DROP: '/art/card-secret_stock_drop_0_2_spy.webp',
};
