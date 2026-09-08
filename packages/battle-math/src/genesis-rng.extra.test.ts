import { cardsOfRarity } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  RARITY_TABLE_FUNDED,
  RARITY_TABLE_SECRET_DISABLED,
  resolveGenesis,
  type GenesisSeedInput,
} from './genesis-rng.js';

const BLOCK = '0x7f3a9c1e2b4d608a5c7e9f1b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3e5f7b9d1a';
const WALLET = '0x1234567890abcdef1234567890abcdef12345678';

const input = (requestId: string): GenesisSeedInput => ({
  finalizedBlockHash: BLOCK,
  wallet: WALLET,
  requestId,
});

describe('rarity table versioning', () => {
  it('records which table produced the result', () => {
    // §76.3: "The table version must be stored with the result." The same slot
    // resolves differently under each table, and §8.3 switches between them
    // automatically on vault coverage without anyone deploying anything - so a
    // replay that does not know which was in force cannot reproduce the result.
    expect(resolveGenesis(input('a'), true).rarityTableVersion).toBe(RARITY_TABLE_FUNDED);
    expect(resolveGenesis(input('a'), false).rarityTableVersion).toBe(RARITY_TABLE_SECRET_DISABLED);
  });

  it('names the two tables distinctly', () => {
    expect(RARITY_TABLE_FUNDED).not.toBe(RARITY_TABLE_SECRET_DISABLED);
  });
});

describe('card selection uses a separate domain', () => {
  it('does not correlate the card with the slot that produced its rarity', () => {
    // §76.4: "A separate hash domain/sub-value should select card type within
    // rarity to avoid ambiguous modulo reuse." Two independent streams rather
    // than two draws from one.
    //
    // A correlated selector would show up as a skew inside a rarity: the slot
    // and the card index would move together. Sampling Commons - the widest
    // band, so the slot varies most - shows all three cards reached evenly.
    const seen = new Map<string, number>();
    let commons = 0;

    for (let i = 0; i < 30_000; i += 1) {
      const outcome = resolveGenesis(input(`corr-${String(i)}`), true);
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

  it('splits a two-card rarity evenly', () => {
    // §9.2: a two-card rarity is a straight 50/50.
    const seen = new Map<string, number>();
    let epics = 0;

    for (let i = 0; i < 60_000; i += 1) {
      const outcome = resolveGenesis(input(`epic-${String(i)}`), true);
      if (outcome.rarity !== 'EPIC') continue;
      epics += 1;
      seen.set(outcome.cardType, (seen.get(outcome.cardType) ?? 0) + 1);
    }

    expect(epics).toBeGreaterThan(1_000);
    expect(seen.size).toBe(2);
    for (const count of seen.values()) {
      expect(count / epics).toBeGreaterThan(0.45);
      expect(count / epics).toBeLessThan(0.55);
    }
  });

  it('stays deterministic across the change', () => {
    expect(resolveGenesis(input('stable'), true)).toEqual(resolveGenesis(input('stable'), true));
  });
});
