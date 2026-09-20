import { CARD_CATALOG, CARD_TYPES, RARITIES } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { cardLadder } from './card-ladder.js';

/**
 * What the Genesis page may say the pool is (§7.2).
 */

describe('the card ladder', () => {
  it('shows every card in the catalog, once', () => {
    // A ladder with its own copy of the pool drifts from the engine the first
    // time a card changes, and a page that disagrees with the scoring is worse
    // than a page that says nothing.
    const listed = cardLadder().flatMap((rung) => rung.cards.map((card) => card.type));

    expect([...listed].sort()).toEqual([...CARD_TYPES].sort());
  });

  it('names each card as §7.2 names it', () => {
    for (const rung of cardLadder()) {
      for (const card of rung.cards) {
        expect(card.name).toBe(CARD_CATALOG[card.type].name);
      }
    }
  });

  it('puts every card under its own rarity', () => {
    for (const rung of cardLadder()) {
      for (const card of rung.cards) {
        expect(CARD_CATALOG[card.type].rarity).toBe(rung.rarity);
      }
    }
  });

  it('runs in the order the rarities are locked in', () => {
    const order = cardLadder().map((rung) => rung.rarity);
    expect(order).toEqual(RARITIES.filter((rarity) => order.includes(rarity)));
  });

  it("says what each card contributes, in the card face's own words", () => {
    for (const rung of cardLadder()) {
      for (const card of rung.cards) {
        expect(card.effect.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives the Secret no battle support (§8.1)', () => {
    // A Genesis outcome, not a stronger card. Printing a support figure for it
    // would make it look like one.
    const secret = cardLadder().find((rung) => rung.rarity === 'SECRET');
    expect(secret?.cards).toHaveLength(1);
    expect(secret?.cards[0]?.effect).toBe('No battle support');
  });
});
