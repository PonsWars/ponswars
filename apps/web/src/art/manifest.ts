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
 * Painted illustrations, for the three cards that have one.
 *
 * The illustration rather than the card. Each master is a finished card render
 * — frame, rarity banner, name plate, charge count — and the application draws
 * its own frame for all fourteen, so what these files hold is the picture cut
 * out of the middle. `build-art.mjs` does the cutting.
 *
 * `Partial`, and deliberately so: §7 has fourteen cards and three of them were
 * painted. `GenesisCardFace` draws a device for the other eleven, so a missing
 * entry is a different picture rather than a missing one — which is what makes
 * it safe for this map to be honest about what exists.
 */
export const CARD_ART: Readonly<Partial<Record<CardType, string>>> = {
  REINFORCEMENT: '/art/card-art-common_reinforcement.webp',
  GOLDEN_ARMY: '/art/card-art-legendary_golden_army.webp',
  SECRET_STOCK_DROP: '/art/card-art-secret_stock_drop_0_2_spy.webp',
};
