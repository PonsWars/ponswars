import {
  CARD_CATALOG,
  cardsOfRarity,
  RARITIES,
  RARITY_USES,
  RNG_SLOT_COUNT,
  type Rarity,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  deriveGenesisSeed,
  initialUsesFor,
  resolveGenesis,
  verifyGenesis,
  type GenesisSeedInput,
} from './genesis-rng.js';

const BLOCK = '0x7f3a9c1e2b4d608a5c7e9f1b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3e5f7b9d1a';
const WALLET = '0x1234567890abcdef1234567890abcdef12345678';

const input = (overrides: Partial<GenesisSeedInput> = {}): GenesisSeedInput => ({
  finalizedBlockHash: BLOCK,
  wallet: WALLET,
  requestId: 'req-0001',
  ...overrides,
});

describe('deriveGenesisSeed', () => {
  it('is deterministic', () => {
    expect(deriveGenesisSeed(input())).toBe(deriveGenesisSeed(input()));
  });

  it('is wallet specific', () => {
    // §9: the seed is wallet-specific, so two wallets requesting against the
    // same block cannot share an outcome.
    const other = input({ wallet: '0x000000000000000000000000000000000000dead' });
    expect(deriveGenesisSeed(other)).not.toBe(deriveGenesisSeed(input()));
  });

  it('is request specific', () => {
    expect(deriveGenesisSeed(input({ requestId: 'req-0002' }))).not.toBe(
      deriveGenesisSeed(input()),
    );
  });

  it('is block specific', () => {
    const other = input({ finalizedBlockHash: `0x${'11'.repeat(32)}` });
    expect(deriveGenesisSeed(other)).not.toBe(deriveGenesisSeed(input()));
  });

  it('ignores hex casing and prefix', () => {
    expect(deriveGenesisSeed(input({ wallet: WALLET.toUpperCase() }))).toBe(
      deriveGenesisSeed(input()),
    );
    expect(deriveGenesisSeed(input({ finalizedBlockHash: BLOCK.slice(2) }))).toBe(
      deriveGenesisSeed(input()),
    );
  });

  it('length-prefixes fields so no two tuples share a preimage', () => {
    // Without prefixes, a wallet and request id could concatenate to the same
    // bytes as a different pairing and silently give two wallets one card.
    expect(deriveGenesisSeed(input({ requestId: 'ab' }))).not.toBe(
      deriveGenesisSeed(input({ requestId: 'a' })),
    );
  });

  it('rejects malformed input', () => {
    expect(() => deriveGenesisSeed(input({ finalizedBlockHash: '' }))).toThrow(TypeError);
    expect(() => deriveGenesisSeed(input({ wallet: '0xzz' }))).toThrow(TypeError);
    expect(() => deriveGenesisSeed(input({ wallet: '0xabc' }))).toThrow(TypeError);
    expect(() => deriveGenesisSeed(input({ requestId: '' }))).toThrow(TypeError);
  });
});

describe('resolveGenesis', () => {
  it('produces a slot inside the locked slot space', () => {
    const outcome = resolveGenesis(input(), true);
    expect(Number.isInteger(outcome.slot)).toBe(true);
    expect(outcome.slot).toBeGreaterThanOrEqual(0);
    expect(outcome.slot).toBeLessThan(RNG_SLOT_COUNT);
  });

  it('is fully deterministic', () => {
    // The property that makes a result un-rerollable: a retry with the same
    // permanent request id returns the same card, so refreshing changes nothing.
    expect(resolveGenesis(input(), true)).toEqual(resolveGenesis(input(), true));
  });

  it('picks a card belonging to the drawn rarity', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const outcome = resolveGenesis(input({ requestId: `req-${String(i)}` }), true);
      expect(CARD_CATALOG[outcome.cardType].rarity).toBe(outcome.rarity);
    }
  });

  it('records the seed and coverage as evidence', () => {
    // §26: a third party recomputes the result from the record. The coverage
    // flag matters because the same slot yields a different rarity without it.
    const outcome = resolveGenesis(input(), false);
    expect(outcome.seed).toBe(deriveGenesisSeed(input()));
    expect(outcome.secretAvailable).toBe(false);
  });

  it('never yields SECRET while the vault is uncovered', () => {
    // §8.3, and the reason coverage is checked before the reveal.
    for (let i = 0; i < 5_000; i += 1) {
      const outcome = resolveGenesis(input({ requestId: `dry-${String(i)}` }), false);
      expect(outcome.rarity).not.toBe('SECRET');
      expect(outcome.cardType).not.toBe('SECRET_STOCK_DROP');
    }
  });

  /**
   * The one test here with its own time budget.
   *
   * Two hundred thousand keyed draws take a couple of seconds alone and longer
   * when fifty workers share a machine, which put it past Vitest's five-second
   * default: it passed on its own and failed in a full run. The sample size is
   * what gives the tolerances below their meaning, so the budget moves rather
   * than the trials — a test whose result depends on how busy the machine is
   * reports on the machine rather than on the draw.
   */
  const SAMPLE_BUDGET_MS = 30_000;

  it(
    'reproduces the locked distribution over a large sample',
    () => {
      // Not a proof, but a drifted slot mapping or a biased draw shows up here.
      const counts: Record<Rarity, number> = {
        COMMON: 0,
        UNCOMMON: 0,
        RARE: 0,
        EPIC: 0,
        LEGENDARY: 0,
        SECRET: 0,
      };
      const trials = 200_000;
      for (let i = 0; i < trials; i += 1) {
        counts[resolveGenesis(input({ requestId: `s-${String(i)}` }), true).rarity] += 1;
      }
      expect(counts.COMMON / trials).toBeGreaterThan(0.49);
      expect(counts.COMMON / trials).toBeLessThan(0.51);
      expect(counts.UNCOMMON / trials).toBeGreaterThan(0.27);
      expect(counts.UNCOMMON / trials).toBeLessThan(0.29);
      expect(counts.RARE / trials).toBeGreaterThan(0.13);
      expect(counts.RARE / trials).toBeLessThan(0.15);
      expect(counts.EPIC / trials).toBeGreaterThan(0.055);
      expect(counts.EPIC / trials).toBeLessThan(0.065);
      expect(counts.LEGENDARY / trials).toBeGreaterThan(0.014);
      expect(counts.LEGENDARY / trials).toBeLessThan(0.024);
      expect(counts.SECRET).toBeGreaterThan(0);
    },
    SAMPLE_BUDGET_MS,
  );

  it('spreads evenly across the cards within a rarity', () => {
    // §9.2: a three-card rarity is a third each, a two-card rarity is 50/50.
    const seen = new Map<string, number>();
    let commons = 0;
    for (let i = 0; i < 40_000; i += 1) {
      const outcome = resolveGenesis(input({ requestId: `c-${String(i)}` }), true);
      if (outcome.rarity !== 'COMMON') continue;
      commons += 1;
      seen.set(outcome.cardType, (seen.get(outcome.cardType) ?? 0) + 1);
    }
    expect(seen.size).toBe(cardsOfRarity('COMMON').length);
    for (const count of seen.values()) {
      expect(count / commons).toBeGreaterThan(0.31);
      expect(count / commons).toBeLessThan(0.36);
    }
  });
});

describe('verifyGenesis', () => {
  it('accepts a correctly recorded outcome', () => {
    const outcome = resolveGenesis(input(), true);
    expect(verifyGenesis(input(), true, outcome)).toBe(true);
  });

  it('rejects a tampered rarity, card or slot', () => {
    // The audit path: a published result that does not recompute is caught
    // without trusting the service that produced it.
    const outcome = resolveGenesis(input(), true);
    const wrongRarity: Rarity = outcome.rarity === 'COMMON' ? 'LEGENDARY' : 'COMMON';
    expect(verifyGenesis(input(), true, { ...outcome, rarity: wrongRarity })).toBe(false);
    expect(verifyGenesis(input(), true, { ...outcome, slot: outcome.slot + 1 })).toBe(false);
    expect(verifyGenesis(input(), true, { ...outcome, cardType: 'SECRET_STOCK_DROP' })).toBe(false);
  });

  it('verifies under the coverage the result was committed with', () => {
    const covered = resolveGenesis(input({ requestId: 'cov' }), true);
    expect(verifyGenesis(input({ requestId: 'cov' }), true, covered)).toBe(true);
  });
});

describe('initialUsesFor', () => {
  it('matches the locked charge counts for every card', () => {
    for (const rarity of RARITIES) {
      for (const card of cardsOfRarity(rarity)) {
        expect(initialUsesFor(card.type)).toBe(RARITY_USES[rarity]);
      }
    }
  });

  it('grants the Secret card a single claim', () => {
    expect(initialUsesFor('SECRET_STOCK_DROP')).toBe(1);
  });
});
