import { describe, expect, it } from 'vitest';
import { CARD_SUPPORT_CHANNELS } from './battle.js';
import {
  CARD_APPLIES_TO_BACKED_STOCK_ONLY,
  CARD_CATALOG,
  CARD_DECISIONS,
  CARD_DEPLOYMENTS_PER_WALLET_PER_ROUND,
  CARD_MID_BATTLE_ACTIVATION_ALLOWED,
  CARD_TYPES,
  CARD_USAGE_EVENTS,
  cardsOfRarity,
  SUPPORT_UNIT_SCALE,
  totalSupportTenths,
} from './cards.js';
import { RARITIES, RARITY_USES, type Rarity } from './genesis.js';

describe('catalog integrity', () => {
  it('defines every declared card and no more', () => {
    expect(Object.keys(CARD_CATALOG).sort()).toEqual([...CARD_TYPES].sort());
    expect(CARD_TYPES).toHaveLength(14);
  });

  it('keys every card by its own type', () => {
    for (const type of CARD_TYPES) {
      expect(CARD_CATALOG[type].type).toBe(type);
    }
  });

  it('gives every card a name and a visual signature', () => {
    for (const type of CARD_TYPES) {
      expect(CARD_CATALOG[type].name.length).toBeGreaterThan(0);
      expect(CARD_CATALOG[type].visualSignature.length).toBeGreaterThan(0);
    }
  });

  it('names every support channel on every card', () => {
    // A missing channel would read as undefined and poison the aggregate.
    for (const type of CARD_TYPES) {
      const { support } = CARD_CATALOG[type];
      for (const channel of CARD_SUPPORT_CHANNELS) {
        expect(Number.isInteger(support[channel])).toBe(true);
        expect(support[channel]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('stores every support value as an integer number of tenths', () => {
    // Standard §66.4: one deterministic numerical strategy across production,
    // replay and tests. A fractional value here would reintroduce floats into
    // the aggregation path.
    expect(SUPPORT_UNIT_SCALE).toBe(10);
    for (const type of CARD_TYPES) {
      for (const channel of CARD_SUPPORT_CHANNELS) {
        expect(Number.isInteger(CARD_CATALOG[type].support[channel])).toBe(true);
      }
    }
  });
});

describe('rarity composition', () => {
  it.each([
    ['COMMON', 3],
    ['UNCOMMON', 3],
    ['RARE', 3],
    ['EPIC', 2],
    ['LEGENDARY', 2],
    ['SECRET', 1],
  ] as const)('gives %s exactly %i card(s)', (rarity, count) => {
    // §7.2, and §7.3 selection: a three-card rarity is 1/3 each, a two-card
    // rarity is 50/50. The counts are what make those splits well-defined.
    expect(cardsOfRarity(rarity)).toHaveLength(count);
  });

  it('assigns every card to a known rarity and covers them all', () => {
    const covered = new Set<Rarity>();
    for (const type of CARD_TYPES) {
      const { rarity } = CARD_CATALOG[type];
      expect(RARITIES).toContain(rarity);
      covered.add(rarity);
    }
    expect(covered.size).toBe(RARITIES.length);
  });

  it('accounts for every card exactly once across all rarities', () => {
    const total = RARITIES.reduce((sum, rarity) => sum + cardsOfRarity(rarity).length, 0);
    expect(total).toBe(CARD_TYPES.length);
  });
});

describe('locked support values', () => {
  it.each([
    ['REINFORCEMENT', { general: 10 }],
    ['MARKET_SIGNAL', { market: 10 }],
    ['SUPPLY_DROP', { pons: 10 }],
    ['HEAVY_REINFORCEMENT', { general: 15 }],
    ['VOLUME_BOOSTER', { volume: 15 }],
    ['MARKET_AMPLIFIER', { market: 15 }],
    ['BULL_RUN', { market: 20 }],
    ['LIQUIDITY_WAVE', { volume: 20 }],
    ['PONS_SURGE', { pons: 20 }],
    ['WAR_MACHINE', { general: 30 }],
    ['TRIPLE_ENGINE', { market: 15, volume: 15, pons: 15 }],
    ['GOLDEN_ARMY', { general: 50 }],
    ['MARKET_DOMINANCE', { market: 25, volume: 25, pons: 25 }],
  ] as const)('%s matches masterplan section 7.2', (type, expected) => {
    expect(CARD_CATALOG[type].support).toMatchObject(expected);
  });

  it('gives the Secret card no battle support at all', () => {
    // §8.1: Secret is a distinct Genesis outcome granting a real tokenized
    // reward, not a stronger buff. Any nonzero value here would make the
    // rarest outcome also the strongest card.
    expect(totalSupportTenths(CARD_CATALOG.SECRET_STOCK_DROP.support)).toBe(0);
  });

  it('raises total support as rarity rises', () => {
    const best = (rarity: Rarity): number =>
      Math.max(...cardsOfRarity(rarity).map((card) => totalSupportTenths(card.support)));

    expect(best('COMMON')).toBe(10);
    expect(best('UNCOMMON')).toBe(15);
    expect(best('RARE')).toBe(20);
    expect(best('EPIC')).toBe(45);
    expect(best('LEGENDARY')).toBe(75);
    expect(best('COMMON')).toBeLessThan(best('UNCOMMON'));
    expect(best('UNCOMMON')).toBeLessThan(best('RARE'));
    expect(best('RARE')).toBeLessThan(best('EPIC'));
    expect(best('EPIC')).toBeLessThan(best('LEGENDARY'));
  });

  it('trades charge count against support strength', () => {
    // A Legendary hits harder but is spent in three rounds; a Common is weaker
    // across twenty. That trade is the whole shape of the card economy.
    const best = (rarity: Rarity): number =>
      Math.max(...cardsOfRarity(rarity).map((card) => totalSupportTenths(card.support)));
    const battleRarities = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;
    for (let i = 0; i < battleRarities.length - 1; i += 1) {
      const lower = battleRarities[i];
      const higher = battleRarities[i + 1];
      expect(lower).toBeDefined();
      expect(higher).toBeDefined();
      expect(best(lower!)).toBeLessThan(best(higher!));
      expect(RARITY_USES[lower!]).toBeGreaterThan(RARITY_USES[higher!]);
    }
  });

  it('spreads multi-channel cards evenly across the three scoring channels', () => {
    // Triple Engine and Market Dominance apply the same value to market,
    // volume and pons (§7.2) and nothing to general.
    for (const type of ['TRIPLE_ENGINE', 'MARKET_DOMINANCE'] as const) {
      const { support } = CARD_CATALOG[type];
      expect(support.market).toBe(support.volume);
      expect(support.volume).toBe(support.pons);
      expect(support.general).toBe(0);
    }
  });
});

describe('usage rules', () => {
  it('offers exactly USE and SAVE', () => {
    expect([...CARD_DECISIONS]).toEqual(['USE', 'SAVE']);
  });

  it('allows one deployment per wallet per round, on the backed stock only', () => {
    expect(CARD_DEPLOYMENTS_PER_WALLET_PER_ROUND).toBe(1);
    expect(CARD_APPLIES_TO_BACKED_STOCK_ONLY).toBe(true);
  });

  it('forbids mid-battle activation', () => {
    // §7.3: no mid-battle activation, no switching after lock.
    expect(CARD_MID_BATTLE_ACTIVATION_ALLOWED).toBe(false);
  });

  it('records deploys, void refunds and explicit corrections only', () => {
    // §49.5 keeps the ledger append-only. A silent decrement or an unlabelled
    // adjustment would break the audit trail a refund depends on.
    expect([...CARD_USAGE_EVENTS]).toEqual(['DEPLOY', 'VOID_REFUND', 'CORRECTION']);
  });
});

describe('totalSupportTenths', () => {
  it('sums all four channels', () => {
    expect(totalSupportTenths({ market: 15, volume: 15, pons: 15, general: 0 })).toBe(45);
    expect(totalSupportTenths({ market: 0, volume: 0, pons: 0, general: 0 })).toBe(0);
  });

  it('stays exact where a decimal representation would not', () => {
    // 1.5 + 1.5 + 1.5 in tenths is 45 exactly. The float equivalent is only
    // reliable for small sums; the aggregate path adds tens of thousands.
    const oneAndAHalf = { market: 15, volume: 15, pons: 15, general: 0 };
    let total = 0;
    for (let i = 0; i < 100_000; i += 1) {
      total += totalSupportTenths(oneAndAHalf);
    }
    expect(total).toBe(4_500_000);
    expect(Number.isInteger(total)).toBe(true);
  });
});
