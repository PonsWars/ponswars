import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BATTLE_SCORE_COMPONENTS,
  BATTLE_SCORE_TOTAL,
  BATTLE_SCORE_WEIGHTS,
  BATTLE_SIDES,
  CARD_SUPPORT_CHANNELS,
  CARD_SUPPORT_MAX_POINTS,
  CARD_SUPPORT_TIERS,
  FRONTLINE_REFERENCE_POINTS,
  MOMENTUM_STATES,
  opposingSide,
  PONS_POWER_COMPOSITION,
  TIEBREAK_ORDER,
  totalScore,
  VICTORY_LABELS,
  VISUAL_EVENT_CUES,
  type BattleScoreComponent,
  type PublicBattleStateUpdate,
} from './battle.js';

describe('locked score weights', () => {
  it('assigns 45/25/20/10', () => {
    expect(BATTLE_SCORE_WEIGHTS).toEqual({
      priceMomentum: 45,
      relativeVolume: 25,
      ponsPower: 20,
      holderCardSupport: 10,
    });
  });

  it('sums to exactly 100', () => {
    // §12: "No component may steal weight from another component." If this ever
    // fails, some component has been rebalanced without a masterplan revision.
    const sum = BATTLE_SCORE_COMPONENTS.reduce(
      (total, component) => total + BATTLE_SCORE_WEIGHTS[component],
      0,
    );
    expect(sum).toBe(BATTLE_SCORE_TOTAL);
    expect(sum).toBe(100);
  });

  it('weights a component for every declared component and no more', () => {
    expect(Object.keys(BATTLE_SCORE_WEIGHTS).sort()).toEqual([...BATTLE_SCORE_COMPONENTS].sort());
  });

  it('gives price momentum the largest share', () => {
    // Real market behaviour must dominate. A reordering here would change what
    // the game rewards.
    const ranked = [...BATTLE_SCORE_COMPONENTS].sort(
      (a, b) => BATTLE_SCORE_WEIGHTS[b] - BATTLE_SCORE_WEIGHTS[a],
    );
    expect(ranked).toEqual([
      'priceMomentum',
      'relativeVolume',
      'ponsPower',
      'holderCardSupport',
    ] satisfies BattleScoreComponent[]);
  });

  it('caps card support at ten points, the smallest component', () => {
    // §12.4: cards may tilt close wars but cannot overpower real market
    // behaviour. Card support must stay the least influential input.
    expect(CARD_SUPPORT_MAX_POINTS).toBe(10);
    for (const component of BATTLE_SCORE_COMPONENTS) {
      if (component === 'holderCardSupport') continue;
      expect(BATTLE_SCORE_WEIGHTS[component]).toBeGreaterThan(CARD_SUPPORT_MAX_POINTS);
    }
  });

  it('composes Pons Power from 70/30', () => {
    expect(PONS_POWER_COMPOSITION.qualifiedActivity).toBe(70);
    expect(PONS_POWER_COMPOSITION.uniqueActiveWallets).toBe(30);
    expect(
      PONS_POWER_COMPOSITION.qualifiedActivity + PONS_POWER_COMPOSITION.uniqueActiveWallets,
    ).toBe(100);
  });

  it('declares the four card support channels', () => {
    expect([...CARD_SUPPORT_CHANNELS]).toEqual(['market', 'volume', 'pons', 'general']);
  });
});

describe('tiebreak', () => {
  it('follows the locked order and ends on a chain-derived step', () => {
    // §12.7. The final step is deterministic and chain-derived; there is no
    // manual admin winner selection anywhere in this list.
    expect([...TIEBREAK_ORDER]).toEqual([
      'priceMomentum',
      'relativeVolume',
      'ponsPower',
      'chainDerived',
    ]);
    expect(TIEBREAK_ORDER.at(-1)).toBe('chainDerived');
  });

  it('breaks ties by descending component weight before falling back to chain', () => {
    const scored = TIEBREAK_ORDER.filter((step) => step !== 'chainDerived');
    for (let i = 0; i < scored.length - 1; i += 1) {
      const current = scored[i];
      const next = scored[i + 1];
      expect(current).toBeDefined();
      expect(next).toBeDefined();
      expect(BATTLE_SCORE_WEIGHTS[current as BattleScoreComponent]).toBeGreaterThan(
        BATTLE_SCORE_WEIGHTS[next as BattleScoreComponent],
      );
    }
  });

  it('never consults card support as a tiebreak', () => {
    // Letting cards decide a dead-even battle would make them decisive rather
    // than marginal, which §12.4 rules out.
    expect(TIEBREAK_ORDER).not.toContain('holderCardSupport');
  });
});

describe('presentation vocabulary', () => {
  it('declares the five momentum states', () => {
    expect([...MOMENTUM_STATES]).toEqual([
      'CONTESTED',
      'PUSHING',
      'SURGING',
      'DOMINATING',
      'COMEBACK',
    ]);
  });

  it('declares the six victory labels', () => {
    expect([...VICTORY_LABELS]).toEqual([
      'NARROW_VICTORY',
      'VICTORY',
      'DECISIVE_VICTORY',
      'UPSET_VICTORY',
      'MAJOR_UPSET',
      'COMEBACK_VICTORY',
    ]);
  });

  it('declares the four card support tiers', () => {
    expect([...CARD_SUPPORT_TIERS]).toEqual(['LOW', 'MEDIUM', 'HIGH', 'MAX']);
  });

  it('declares the seven cosmetic event cues', () => {
    expect(VISUAL_EVENT_CUES).toHaveLength(7);
    expect(new Set(VISUAL_EVENT_CUES).size).toBe(7);
  });

  it('keeps frontline anchors ordered and inside the unit interval', () => {
    const shares = FRONTLINE_REFERENCE_POINTS.map((point) => point.share);
    expect(shares).toEqual([...shares].sort((a, b) => a - b));
    for (const share of shares) {
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
    }
    expect(shares[0]).toBe(0.5);
  });
});

describe('sides', () => {
  it('has exactly two and they invert', () => {
    expect([...BATTLE_SIDES]).toEqual(['LEFT', 'RIGHT']);
    expect(opposingSide('LEFT')).toBe('RIGHT');
    expect(opposingSide('RIGHT')).toBe('LEFT');
    expect(opposingSide(opposingSide('LEFT'))).toBe('LEFT');
  });
});

describe('public realtime payload', () => {
  it('carries no score field of any kind', () => {
    // §24 and §48.3: the hidden exact score is never sent during a live battle.
    // Asserting on the type keeps a future field addition from silently
    // reopening the leak that Guide §7.2 flags in three delivered PNGs.
    type Keys = keyof PublicBattleStateUpdate;
    expectTypeOf<Keys>().toEqualTypeOf<
      | 'battleId'
      | 'serverTime'
      | 'timeRemaining'
      | 'momentum'
      | 'frontline'
      | 'intensity'
      | 'cardSupport'
      | 'feedHealth'
      | 'visualEvent'
    >();
  });

  it('exposes card support as a tier, never a raw count', () => {
    // §15: thousands of deployed cards must not read as thousands of units.
    expectTypeOf<PublicBattleStateUpdate['cardSupport']>().toEqualTypeOf<
      'LOW' | 'MEDIUM' | 'HIGH' | 'MAX'
    >();
  });

  it('reports feed health without naming the failing vendor', () => {
    expectTypeOf<PublicBattleStateUpdate['feedHealth']>().toEqualTypeOf<'HEALTHY' | 'DEGRADED'>();
  });
});

describe('totalScore', () => {
  it('sums a breakdown', () => {
    expect(
      totalScore({ priceMomentum: 30, relativeVolume: 12, ponsPower: 9, holderCardSupport: 5 }),
    ).toBe(56);
  });

  it('lets two opposing breakdowns account for the full hundred points', () => {
    const left = { priceMomentum: 30, relativeVolume: 12, ponsPower: 9, holderCardSupport: 5 };
    const right = { priceMomentum: 15, relativeVolume: 13, ponsPower: 11, holderCardSupport: 5 };
    expect(totalScore(left) + totalScore(right)).toBe(BATTLE_SCORE_TOTAL);
  });
});
