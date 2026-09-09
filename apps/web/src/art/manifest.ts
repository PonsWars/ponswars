import { ACTIVE_TICKERS, type ActiveTicker, type CardType } from '@ponswars/shared-types';

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
 * Faction art carries original PonsWars emblems and the unit names §39 locks —
 * not the corporate marks the *UI* mockups use as shorthand, which §7.10 warns
 * are not cleared assets. That distinction is why these can ship and those
 * mockups cannot.
 */

/** A faction's dossier: its legion, its sector, its units (§39). */
export const FACTION_ART: Readonly<Record<ActiveTicker, string>> = {
  NVDA: '/art/faction-nvda_ai_mech_legion.webp',
  AAPL: '/art/faction-aapl_titanium_guard.webp',
  MSFT: '/art/faction-msft_azure_cyber_corps.webp',
  TSLA: '/art/faction-tsla_mars_vanguard.webp',
  GME: '/art/faction-gme_retail_rebellion.webp',
  META: '/art/faction-meta_reality_legion.webp',
  AMZN: '/art/faction-amzn_fulfillment_army.webp',
  GOOGL: '/art/faction-googl_intelligence_division.webp',
  AMD: '/art/faction-amd_red_core_battalion.webp',
  SPY: '/art/faction-spy_market_federation.webp',
};

/**
 * The faction's legion name, as its own dossier titles it (§39).
 *
 * Beside the ticker rather than instead of it. §36.7 requires a faction to stay
 * identifiable without colour, and a name does that where an accent alone
 * cannot — but the ticker is what the round, the result and the ledger call it,
 * so the ticker stays the identifier.
 */
export const FACTION_LEGION: Readonly<Record<ActiveTicker, string>> = {
  NVDA: 'AI MECH LEGION',
  AAPL: 'TITANIUM GUARD',
  MSFT: 'AZURE CYBER CORPS',
  TSLA: 'MARS VANGUARD',
  GME: 'RETAIL REBELLION',
  META: 'REALITY LEGION',
  AMZN: 'FULFILLMENT ARMY',
  GOOGL: 'INTELLIGENCE DIVISION',
  AMD: 'RED CORE BATTALION',
  SPY: 'MARKET FEDERATION',
};

/**
 * Card art, for the three cards that have any.
 *
 * `Partial`, and deliberately so: §7 has a catalog of cards and three of them
 * were drawn. A record claiming every card had art would make a missing file a
 * broken image at the moment a player opens a Genesis reveal, which is the one
 * moment §40.6 asks to feel like a reveal.
 */
export const CARD_ART: Partial<Readonly<Record<CardType, string>>> = {
  REINFORCEMENT: '/art/card-common_reinforcement.webp',
  GOLDEN_ARMY: '/art/card-legendary_golden_army.webp',
  SECRET_STOCK_DROP: '/art/card-secret_stock_drop_0_2_spy.webp',
};

/** Every faction has art, and this fails the build if one stops having it. */
export const FACTIONS_WITH_ART: readonly ActiveTicker[] = ACTIVE_TICKERS;
