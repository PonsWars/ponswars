import type { CardSupportChannel } from './battle.js';
import type { Rarity } from './genesis.js';

/**
 * The Genesis card pool, its support values and the card usage lifecycle.
 *
 * Masterplan §7.2 (pool), §7.3 (usage rules), §12.4 (how support scores),
 * §15 (visual effects), §49.5 (usage ledger).
 */

/**
 * Support values are stored as integer tenths of a support unit.
 *
 * The masterplan writes them as `+1`, `+1.5`, `+2.5`, `+5`. Storing `15` rather
 * than `1.5` keeps the whole support pipeline in integer arithmetic:
 * standard §66.4 requires one deterministic numerical strategy shared by
 * production, replay and tests, and aggregating tens of thousands of decimal
 * contributions is exactly where a float strategy starts to drift between
 * implementations.
 */
export const SUPPORT_UNIT_SCALE = 10;

/** A support contribution per channel, in tenths of a support unit. */
export type SupportTenths = Readonly<Record<CardSupportChannel, number>>;

const NO_SUPPORT: SupportTenths = { market: 0, volume: 0, pons: 0, general: 0 };

/** Every card in the V1 pool (§7.2). */
export const CARD_TYPES = [
  'REINFORCEMENT',
  'MARKET_SIGNAL',
  'SUPPLY_DROP',
  'HEAVY_REINFORCEMENT',
  'VOLUME_BOOSTER',
  'MARKET_AMPLIFIER',
  'BULL_RUN',
  'LIQUIDITY_WAVE',
  'PONS_SURGE',
  'WAR_MACHINE',
  'TRIPLE_ENGINE',
  'GOLDEN_ARMY',
  'MARKET_DOMINANCE',
  'SECRET_STOCK_DROP',
] as const;

export type CardType = (typeof CARD_TYPES)[number];

export interface CardDefinition {
  readonly type: CardType;
  /** Product-facing name exactly as written in §7.2. */
  readonly name: string;
  readonly rarity: Rarity;
  /** Per-channel support in tenths (§12.4). */
  readonly support: SupportTenths;
  /**
   * Signature deployment visual (§15).
   *
   * Presentation only. Aggregate community support maps to a summarized
   * intensity tier — thousands of deployed cards must never become thousands
   * of literal extra units.
   */
  readonly visualSignature: string;
}

export const CARD_CATALOG: Readonly<Record<CardType, CardDefinition>> = {
  // Common — +1 (§7.2)
  REINFORCEMENT: {
    type: 'REINFORCEMENT',
    name: 'Reinforcement',
    rarity: 'COMMON',
    support: { ...NO_SUPPORT, general: 10 },
    visualSignature: 'Additional squad deployment',
  },
  MARKET_SIGNAL: {
    type: 'MARKET_SIGNAL',
    name: 'Market Signal',
    rarity: 'COMMON',
    support: { ...NO_SUPPORT, market: 10 },
    visualSignature: 'Tactical market signal flare',
  },
  SUPPLY_DROP: {
    type: 'SUPPLY_DROP',
    name: 'Supply Drop',
    rarity: 'COMMON',
    support: { ...NO_SUPPORT, pons: 10 },
    visualSignature: 'Pons-themed supply canister drop',
  },

  // Uncommon — +1.5 (§7.2)
  HEAVY_REINFORCEMENT: {
    type: 'HEAVY_REINFORCEMENT',
    name: 'Heavy Reinforcement',
    rarity: 'UNCOMMON',
    support: { ...NO_SUPPORT, general: 15 },
    visualSignature: 'Heavy unit column arrival',
  },
  VOLUME_BOOSTER: {
    type: 'VOLUME_BOOSTER',
    name: 'Volume Booster',
    rarity: 'UNCOMMON',
    support: { ...NO_SUPPORT, volume: 15 },
    visualSignature: 'Throughput surge along supply routes',
  },
  MARKET_AMPLIFIER: {
    type: 'MARKET_AMPLIFIER',
    name: 'Market Amplifier',
    rarity: 'UNCOMMON',
    support: { ...NO_SUPPORT, market: 15 },
    visualSignature: 'Amplified market broadcast',
  },

  // Rare — +2 (§7.2)
  BULL_RUN: {
    type: 'BULL_RUN',
    name: 'Bull Run',
    rarity: 'RARE',
    support: { ...NO_SUPPORT, market: 20 },
    visualSignature: 'Offensive charge with bull motif',
  },
  LIQUIDITY_WAVE: {
    type: 'LIQUIDITY_WAVE',
    name: 'Liquidity Wave',
    rarity: 'RARE',
    support: { ...NO_SUPPORT, volume: 20 },
    visualSignature: 'Energy and supply flow across the field',
  },
  PONS_SURGE: {
    type: 'PONS_SURGE',
    name: 'Pons Surge',
    rarity: 'RARE',
    support: { ...NO_SUPPORT, pons: 20 },
    visualSignature: 'Pons-themed reinforcement surge',
  },

  // Epic (§7.2)
  WAR_MACHINE: {
    type: 'WAR_MACHINE',
    name: 'War Machine',
    rarity: 'EPIC',
    support: { ...NO_SUPPORT, general: 30 },
    visualSignature: 'Heavy mech arrival',
  },
  TRIPLE_ENGINE: {
    type: 'TRIPLE_ENGINE',
    name: 'Triple Engine',
    rarity: 'EPIC',
    support: { market: 15, volume: 15, pons: 15, general: 0 },
    visualSignature: 'Three-channel engine ignition',
  },

  // Legendary (§7.2)
  GOLDEN_ARMY: {
    type: 'GOLDEN_ARMY',
    name: 'Golden Army',
    rarity: 'LEGENDARY',
    support: { ...NO_SUPPORT, general: 50 },
    visualSignature: 'Elite golden battalion deployment',
  },
  MARKET_DOMINANCE: {
    type: 'MARKET_DOMINANCE',
    name: 'Market Dominance',
    rarity: 'LEGENDARY',
    support: { market: 25, volume: 25, pons: 25, general: 0 },
    visualSignature: 'Full-spectrum dominance sweep',
  },

  // Secret (§8.1)
  SECRET_STOCK_DROP: {
    type: 'SECRET_STOCK_DROP',
    name: 'Secret Stock Drop',
    rarity: 'SECRET',
    // No battle buff. Secret is a distinct Genesis outcome granting a real
    // tokenized-stock reward, not a stronger card (§8.1).
    support: NO_SUPPORT,
    visualSignature: 'Anomalous classification signal',
  },
} as const;

/** Cards belonging to a rarity, in catalog order. */
export function cardsOfRarity(rarity: Rarity): readonly CardDefinition[] {
  return CARD_TYPES.map((type) => CARD_CATALOG[type]).filter((card) => card.rarity === rarity);
}

/**
 * Total support a card contributes, in tenths, before channel weighting,
 * diminishing returns and the 10-point cap are applied (§12.4).
 */
export function totalSupportTenths(support: SupportTenths): number {
  return support.market + support.volume + support.pons + support.general;
}

// ---------------------------------------------------------------------------
// Usage — LOCKED (§7.3)
// ---------------------------------------------------------------------------

/**
 * The player's decision during Pick Phase (§27.6, §47.6).
 *
 * `USE` only *arms* the card. The charge is consumed atomically when the round
 * enters lock (§3.2, §47.6), never at the moment the button is pressed.
 */
export const CARD_DECISIONS = ['USE', 'SAVE'] as const;

export type CardDecision = (typeof CARD_DECISIONS)[number];

/** One card deployment per wallet per round (§7.3). */
export const CARD_DEPLOYMENTS_PER_WALLET_PER_ROUND = 1;

/** A card applies only to the stock its owner backed that round (§7.3). */
export const CARD_APPLIES_TO_BACKED_STOCK_ONLY = true;

/** No activation once the battle is live (§7.3). */
export const CARD_MID_BATTLE_ACTIVATION_ALLOWED = false;

/**
 * Append-only card usage ledger events (§49.5).
 *
 * `DEPLOY` consumes a charge at lock regardless of win or loss (§7.3).
 * `VOID_REFUND` restores it when a battle voids on integrity grounds (§4.4) and
 * must be idempotent — a retried refund cannot hand back a second charge.
 * `CORRECTION` is the only other writer and always carries an explicit reason.
 */
export const CARD_USAGE_EVENTS = ['DEPLOY', 'VOID_REFUND', 'CORRECTION'] as const;

export type CardUsageEvent = (typeof CARD_USAGE_EVENTS)[number];
