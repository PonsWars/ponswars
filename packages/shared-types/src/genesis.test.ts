import { describe, expect, it } from 'vitest';
import {
  buildSlotTable,
  canTransitionGenesisRequest,
  GENESIS_CLAIMS_PER_WALLET,
  GENESIS_DOMAIN_SEPARATOR,
  GENESIS_HOLDING_DURATION_REQUIRED,
  GENESIS_REQUEST_STATES,
  GENESIS_REQUEST_TRANSITIONS,
  GENESIS_TRANSFERABLE,
  GENESIS_WAR_THRESHOLD_DECIMAL,
  RARITIES,
  RARITY_RATE_BPS,
  RARITY_RATE_BPS_SECRET_DISABLED,
  RARITY_SLOT_TABLE,
  RARITY_USES,
  rarityForSlot,
  RNG_SLOT_COUNT,
  SLOTS_PER_BASIS_POINT,
  type Rarity,
} from './genesis.js';
import { parseDecimalToBaseUnits, tokenDecimals } from './money.js';

const sumBps = (rates: Readonly<Record<Rarity, number>>): number =>
  RARITIES.reduce((total, rarity) => total + rates[rarity], 0);

describe('eligibility', () => {
  it('requires one million WAR held now, with no waiting period', () => {
    expect(GENESIS_WAR_THRESHOLD_DECIMAL).toBe('1000000');
    expect(GENESIS_HOLDING_DURATION_REQUIRED).toBe(false);
  });

  it('states the threshold as a decimal so token decimals stay open', () => {
    // $WAR decimals are OPEN. The threshold must convert exactly at whatever
    // precision the token turns out to use, without a float ever appearing.
    expect(parseDecimalToBaseUnits(GENESIS_WAR_THRESHOLD_DECIMAL, tokenDecimals(18))).toBe(
      1_000_000_000_000_000_000_000_000n,
    );
    expect(parseDecimalToBaseUnits(GENESIS_WAR_THRESHOLD_DECIMAL, tokenDecimals(6))).toBe(
      1_000_000_000_000n,
    );
  });

  it('grants one non-transferable claim per wallet', () => {
    expect(GENESIS_CLAIMS_PER_WALLET).toBe(1);
    expect(GENESIS_TRANSFERABLE).toBe(false);
  });
});

describe('rarity distribution', () => {
  it('matches the locked 50 / 28 / 14 / 6 / 1.9 / 0.1 split', () => {
    expect(RARITY_RATE_BPS).toEqual({
      COMMON: 5_000,
      UNCOMMON: 2_800,
      RARE: 1_400,
      EPIC: 600,
      LEGENDARY: 190,
      SECRET: 10,
    });
  });

  it('sums to exactly 100 percent', () => {
    expect(sumBps(RARITY_RATE_BPS)).toBe(10_000);
  });

  it('still sums to 100 percent with Secret disabled', () => {
    // §8.3: Secret's 0.1% is reassigned to Legendary, giving 2.00%.
    expect(sumBps(RARITY_RATE_BPS_SECRET_DISABLED)).toBe(10_000);
    expect(RARITY_RATE_BPS_SECRET_DISABLED.LEGENDARY).toBe(200);
    expect(RARITY_RATE_BPS_SECRET_DISABLED.SECRET).toBe(0);
  });

  it('moves exactly Secret’s share into Legendary and nothing else', () => {
    for (const rarity of RARITIES) {
      if (rarity === 'LEGENDARY' || rarity === 'SECRET') continue;
      expect(RARITY_RATE_BPS_SECRET_DISABLED[rarity]).toBe(RARITY_RATE_BPS[rarity]);
    }
    expect(RARITY_RATE_BPS_SECRET_DISABLED.LEGENDARY - RARITY_RATE_BPS.LEGENDARY).toBe(
      RARITY_RATE_BPS.SECRET,
    );
  });

  it('grants the locked charge counts', () => {
    expect(RARITY_USES).toEqual({
      COMMON: 20,
      UNCOMMON: 15,
      RARE: 10,
      EPIC: 5,
      LEGENDARY: 3,
      SECRET: 1,
    });
  });

  it('grants fewer charges as rarity rises', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const rarity of RARITIES) {
      expect(RARITY_USES[rarity]).toBeLessThan(previous);
      previous = RARITY_USES[rarity];
    }
  });

  it('drops more rarely as rarity rises', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const rarity of RARITIES) {
      expect(RARITY_RATE_BPS[rarity]).toBeLessThan(previous);
      previous = RARITY_RATE_BPS[rarity];
    }
  });
});

describe('slot table', () => {
  it('scales basis points to slots with no remainder', () => {
    expect(RNG_SLOT_COUNT).toBe(1_000_000);
    expect(SLOTS_PER_BASIS_POINT * 10_000).toBe(RNG_SLOT_COUNT);
  });

  it('reproduces the exact ranges written in masterplan section 9.1', () => {
    // Derived from the rates rather than transcribed, so the two cannot drift.
    // This test is what proves the derivation agrees with the document.
    expect(RARITY_SLOT_TABLE).toEqual({
      COMMON: { start: 0, end: 499_999 },
      UNCOMMON: { start: 500_000, end: 779_999 },
      RARE: { start: 780_000, end: 919_999 },
      EPIC: { start: 920_000, end: 979_999 },
      LEGENDARY: { start: 980_000, end: 998_999 },
      SECRET: { start: 999_000, end: 999_999 },
    });
  });

  it('covers the whole slot space with no gap and no overlap', () => {
    let expectedStart = 0;
    for (const rarity of RARITIES) {
      const range = RARITY_SLOT_TABLE[rarity];
      expect(range.start).toBe(expectedStart);
      expect(range.end).toBeGreaterThanOrEqual(range.start - 1);
      expectedStart = range.end + 1;
    }
    expect(expectedStart).toBe(RNG_SLOT_COUNT);
  });

  it('gives every rarity a width matching its rate', () => {
    for (const rarity of RARITIES) {
      const range = RARITY_SLOT_TABLE[rarity];
      expect(range.end - range.start + 1).toBe(RARITY_RATE_BPS[rarity] * SLOTS_PER_BASIS_POINT);
    }
  });

  it('produces an empty, unreachable range for a zero rate', () => {
    const table = buildSlotTable(RARITY_RATE_BPS_SECRET_DISABLED);
    expect(table.SECRET.end).toBeLessThan(table.SECRET.start);
  });
});

describe('rarityForSlot', () => {
  it('maps each range boundary to the right rarity', () => {
    expect(rarityForSlot(0, true)).toBe('COMMON');
    expect(rarityForSlot(499_999, true)).toBe('COMMON');
    expect(rarityForSlot(500_000, true)).toBe('UNCOMMON');
    expect(rarityForSlot(779_999, true)).toBe('UNCOMMON');
    expect(rarityForSlot(780_000, true)).toBe('RARE');
    expect(rarityForSlot(919_999, true)).toBe('RARE');
    expect(rarityForSlot(920_000, true)).toBe('EPIC');
    expect(rarityForSlot(979_999, true)).toBe('EPIC');
    expect(rarityForSlot(980_000, true)).toBe('LEGENDARY');
    expect(rarityForSlot(998_999, true)).toBe('LEGENDARY');
    expect(rarityForSlot(999_000, true)).toBe('SECRET');
    expect(rarityForSlot(999_999, true)).toBe('SECRET');
  });

  it('reassigns the Secret band to Legendary when the vault is uncovered', () => {
    // §8.3. A user must never see a Secret reveal without secured coverage,
    // so the band cannot simply be left unreachable — it becomes Legendary.
    expect(rarityForSlot(999_000, false)).toBe('LEGENDARY');
    expect(rarityForSlot(999_999, false)).toBe('LEGENDARY');
    expect(rarityForSlot(980_000, false)).toBe('LEGENDARY');
  });

  it('never returns SECRET while the vault is uncovered', () => {
    for (const slot of [0, 499_999, 500_000, 979_999, 980_000, 998_999, 999_000, 999_999]) {
      expect(rarityForSlot(slot, false)).not.toBe('SECRET');
    }
  });

  it('is total across the entire slot space', () => {
    // Sweep every 997th slot — a prime stride, so it lands inside and across
    // every band rather than aligning with the round boundaries.
    for (let slot = 0; slot < RNG_SLOT_COUNT; slot += 997) {
      expect(RARITIES).toContain(rarityForSlot(slot, true));
      expect(RARITIES).toContain(rarityForSlot(slot, false));
    }
    expect(rarityForSlot(RNG_SLOT_COUNT - 1, true)).toBe('SECRET');
  });

  it('is deterministic', () => {
    // The property that makes a Genesis result replayable and un-rerollable.
    for (const slot of [0, 12_345, 500_000, 998_999, 999_500]) {
      expect(rarityForSlot(slot, true)).toBe(rarityForSlot(slot, true));
    }
  });

  it.each([-1, RNG_SLOT_COUNT, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects out-of-space slot %s',
    (slot) => {
      expect(() => rarityForSlot(slot, true)).toThrow(RangeError);
    },
  );

  it('produces the locked distribution over an exhaustive sweep', () => {
    // Counts every one of the million slots. This is the distribution players
    // actually experience, verified rather than assumed.
    const counts: Record<Rarity, number> = {
      COMMON: 0,
      UNCOMMON: 0,
      RARE: 0,
      EPIC: 0,
      LEGENDARY: 0,
      SECRET: 0,
    };
    for (let slot = 0; slot < RNG_SLOT_COUNT; slot += 1) {
      counts[rarityForSlot(slot, true)] += 1;
    }
    expect(counts).toEqual({
      COMMON: 500_000,
      UNCOMMON: 280_000,
      RARE: 140_000,
      EPIC: 60_000,
      LEGENDARY: 19_000,
      SECRET: 1_000,
    });
  });
});

describe('domain separation', () => {
  it('uses the locked V1 separator', () => {
    // §9, §20: prevents replay across wallets, requests, chains and
    // environments. Versioned so a V2 seed can never collide with a V1 one.
    expect(GENESIS_DOMAIN_SEPARATOR).toBe('PONSWARS_GENESIS_V1');
  });
});

describe('request lifecycle', () => {
  it('declares a transition list for every state', () => {
    expect(Object.keys(GENESIS_REQUEST_TRANSITIONS).sort()).toEqual(
      [...GENESIS_REQUEST_STATES].sort(),
    );
  });

  it('lets a pending request commit or fail', () => {
    expect(canTransitionGenesisRequest('PENDING', 'COMMITTED')).toBe(true);
    expect(canTransitionGenesisRequest('PENDING', 'FAILED')).toBe(true);
  });

  it('never fails a committed request back to a retry', () => {
    // §9: one request cannot be rerolled. Failing a committed request back into
    // a retryable state would be exactly that reroll.
    expect(canTransitionGenesisRequest('COMMITTED', 'FAILED')).toBe(false);
    expect(canTransitionGenesisRequest('COMMITTED', 'PENDING')).toBe(false);
    expect(canTransitionGenesisRequest('COMMITTED', 'FINALIZED')).toBe(true);
  });

  it('never leaves a terminal state', () => {
    expect(GENESIS_REQUEST_TRANSITIONS.FINALIZED).toHaveLength(0);
    expect(GENESIS_REQUEST_TRANSITIONS.FAILED).toHaveLength(0);
    expect(canTransitionGenesisRequest('FINALIZED', 'PENDING')).toBe(false);
  });
});
