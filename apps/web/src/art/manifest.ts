import { ACTIVE_TICKERS, type ActiveTicker, type CardType } from '@ponswars/shared-types';

/**
 * Where the art lives, by what it depicts.
 *
 * A map from a domain value to a file, so nothing composes a path from a string
 * at the point of use. A component that built `/art/faction-${ticker}.webp`
 * would compile, ship, and 404 for every faction whose file was named
 * differently — and this map is the only place that can be got wrong once.
 *
 * The files under `apps/web/public/art` are the web build of the masters, made
 * by `tools/build-art.mjs`. The masters are large PNGs and are not in this
 * repository.
 *
 * The faction plates are generated rather than delivered, and that is not a
 * shortcut. Eight of the ten faction dossiers in the visual pack carry the real
 * corporate mark of the company behind the ticker, and §7.10 is explicit that
 * those are shorthand in concept art rather than cleared production assets.
 * `tools/art/generate.mjs` draws these from the roster instead — the legion
 * name, the identity line, the momentum signature — and never names a company
 * in a prompt. `docs/operations/generated-art.md` has the review that stands
 * between a generation and a commit.
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
  // Painted, from the delivered pack. `build-art.mjs` cuts the illustration out
  // of each finished card render.
  REINFORCEMENT: '/art/card-art-common_reinforcement.webp',
  GOLDEN_ARMY: '/art/card-art-legendary_golden_army.webp',
  SECRET_STOCK_DROP: '/art/card-art-secret_stock_drop_0_2_spy.webp',

  // Generated from each card's own `visualSignature` in the catalog.
  MARKET_SIGNAL: '/art/card-art-market_signal.webp',
  SUPPLY_DROP: '/art/card-art-supply_drop.webp',
  HEAVY_REINFORCEMENT: '/art/card-art-heavy_reinforcement.webp',
  VOLUME_BOOSTER: '/art/card-art-volume_booster.webp',
  MARKET_AMPLIFIER: '/art/card-art-market_amplifier.webp',
  BULL_RUN: '/art/card-art-bull_run.webp',
  LIQUIDITY_WAVE: '/art/card-art-liquidity_wave.webp',
  PONS_SURGE: '/art/card-art-pons_surge.webp',
  WAR_MACHINE: '/art/card-art-war_machine.webp',
  TRIPLE_ENGINE: '/art/card-art-triple_engine.webp',
  MARKET_DOMINANCE: '/art/card-art-market_dominance.webp',
};

/**
 * One plate per faction: its army, in its own territory.
 *
 * A full record rather than a partial one, because all ten exist — and a
 * `Record` is what makes a missing faction a type error rather than a broken
 * image someone finds later. The paths are built from the ticker here, in the
 * one place where the naming and the roster can be compared side by side.
 */
export const FACTION_ART: Readonly<Record<ActiveTicker, string>> = Object.fromEntries(
  ACTIVE_TICKERS.map((ticker) => [ticker, `/art/faction-${ticker.toLowerCase()}.webp`]),
) as Record<ActiveTicker, string>;
