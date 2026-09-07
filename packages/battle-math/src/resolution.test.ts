import { CONFIDENCE_LABELS, TIEBREAK_ORDER } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  chainDerivedSide,
  classifyVictory,
  resolveBattle,
  type VictoryThresholds,
} from './resolution.js';
import { points } from './scale.js';
import type { BattleScore, ScaledBreakdown } from './scoring.js';

const BLOCK_HASH = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const breakdown = (overrides: Partial<ScaledBreakdown> = {}): ScaledBreakdown => ({
  priceMomentum: points(22) + points(1) / 2n,
  relativeVolume: points(12) + points(1) / 2n,
  ponsPower: points(10),
  holderCardSupport: points(5),
  ...overrides,
});

const total = (b: ScaledBreakdown): bigint =>
  b.priceMomentum + b.relativeVolume + b.ponsPower + b.holderCardSupport;

const scoreOf = (left: ScaledBreakdown, right: ScaledBreakdown): BattleScore => ({
  left,
  right,
  leftTotal: total(left),
  rightTotal: total(right),
  edges: { priceMomentum: 0n, relativeVolume: 0n, ponsPower: 0n, holderCardSupport: 0n },
});

const resolve = (left: ScaledBreakdown, right: ScaledBreakdown) =>
  resolveBattle({
    score: scoreOf(left, right),
    left: 'NVDA',
    right: 'AAPL',
    battleId: 'battle-1',
    finalizedBlockHash: BLOCK_HASH,
  });

const THRESHOLDS: VictoryThresholds = { narrowMargin: points(4), decisiveMargin: points(30) };

describe('resolveBattle on a decided battle', () => {
  it('picks the higher total and runs no tiebreak', () => {
    const result = resolve(breakdown({ priceMomentum: points(30) }), breakdown());
    expect(result.winner).toBe('NVDA');
    expect(result.winningSide).toBe('LEFT');
    expect(result.tiebreakStep).toBeUndefined();
  });

  it('reports a non-negative margin whichever side wins', () => {
    const leftWins = resolve(breakdown({ priceMomentum: points(30) }), breakdown());
    const rightWins = resolve(breakdown(), breakdown({ priceMomentum: points(30) }));
    expect(leftWins.margin).toBeGreaterThan(0n);
    expect(rightWins.margin).toBe(leftWins.margin);
    expect(rightWins.winner).toBe('AAPL');
  });

  it('decides on a margin of a single scaled unit', () => {
    // The cutoff is exact (§12.6). A one-unit lead is a lead.
    const result = resolve(breakdown({ ponsPower: points(10) + 1n }), breakdown());
    expect(result.winner).toBe('NVDA');
    expect(result.margin).toBe(1n);
  });
});

describe('tiebreak order', () => {
  it('breaks a tied total on price momentum first', () => {
    // §12.7 step 1. Totals equal, price momentum differs.
    const left = breakdown({ priceMomentum: points(25), relativeVolume: points(10) });
    const right = breakdown({ priceMomentum: points(20), relativeVolume: points(15) });
    expect(total(left)).toBe(total(right));

    const result = resolve(left, right);
    expect(result.tiebreakStep).toBe('priceMomentum');
    expect(result.winner).toBe('NVDA');
  });

  it('falls through to relative volume when price momentum also ties', () => {
    const left = breakdown({ relativeVolume: points(15), ponsPower: points(7) + points(1) / 2n });
    const right = breakdown({ relativeVolume: points(10), ponsPower: points(12) + points(1) / 2n });
    expect(total(left)).toBe(total(right));
    expect(left.priceMomentum).toBe(right.priceMomentum);

    const result = resolve(left, right);
    expect(result.tiebreakStep).toBe('relativeVolume');
  });

  it('falls through to Pons power when both earlier steps tie', () => {
    const left = breakdown({ ponsPower: points(12), holderCardSupport: points(3) });
    const right = breakdown({ ponsPower: points(10), holderCardSupport: points(5) });
    expect(total(left)).toBe(total(right));

    const result = resolve(left, right);
    expect(result.tiebreakStep).toBe('ponsPower');
    expect(result.winner).toBe('NVDA');
  });

  it('falls through to the chain-derived step on a total tie', () => {
    // Identical breakdowns: nothing in the score can separate them, so the
    // decision has to come from outside and be publicly verifiable.
    const result = resolve(breakdown(), breakdown());
    expect(result.tiebreakStep).toBe('chainDerived');
    expect(result.margin).toBe(0n);
    expect(['NVDA', 'AAPL']).toContain(result.winner);
  });

  it('never consults card support', () => {
    // §12.4: cards tilt close wars, they do not decide dead-even ones. A
    // battle tied on every scoring component but differing on cards must fall
    // through to the chain, not to the card holder.
    const left = breakdown({ holderCardSupport: points(9), ponsPower: points(6) });
    const right = breakdown({ holderCardSupport: points(1), ponsPower: points(14) });
    expect(total(left)).toBe(total(right));

    const result = resolve(left, right);
    expect(result.tiebreakStep).toBe('ponsPower');
    expect(result.winner).toBe('AAPL');
    expect(TIEBREAK_ORDER).not.toContain('holderCardSupport');
  });

  it('walks the steps in the locked order', () => {
    expect([...TIEBREAK_ORDER]).toEqual([
      'priceMomentum',
      'relativeVolume',
      'ponsPower',
      'chainDerived',
    ]);
  });
});

describe('chainDerivedSide', () => {
  it('is deterministic for a given block hash and battle', () => {
    expect(chainDerivedSide(BLOCK_HASH, 'battle-1')).toBe(chainDerivedSide(BLOCK_HASH, 'battle-1'));
  });

  it('is insensitive to hash casing and prefix', () => {
    expect(chainDerivedSide(BLOCK_HASH.slice(2), 'b')).toBe(chainDerivedSide(BLOCK_HASH, 'b'));
    expect(chainDerivedSide(BLOCK_HASH.toUpperCase(), 'b')).toBe(chainDerivedSide(BLOCK_HASH, 'b'));
  });

  it('differs across battles in the same block', () => {
    // Five battles finalize together. If they all resolved the same way, a tie
    // in one would predict the tie in the others.
    const sides = new Set(
      Array.from({ length: 20 }, (_, i) => chainDerivedSide(BLOCK_HASH, `battle-${String(i)}`)),
    );
    expect(sides.size).toBe(2);
  });

  it('is roughly balanced across many battles', () => {
    // Not a fairness proof, but a stuck bit would show here immediately.
    let leftCount = 0;
    const trials = 2_000;
    for (let i = 0; i < trials; i += 1) {
      if (chainDerivedSide(BLOCK_HASH, `b-${String(i)}`) === 'LEFT') leftCount += 1;
    }
    expect(leftCount).toBeGreaterThan(trials * 0.45);
    expect(leftCount).toBeLessThan(trials * 0.55);
  });

  it('rejects malformed input', () => {
    expect(() => chainDerivedSide('', 'b')).toThrow(TypeError);
    expect(() => chainDerivedSide('0xzz', 'b')).toThrow(TypeError);
    expect(() => chainDerivedSide(BLOCK_HASH, '')).toThrow(TypeError);
  });
});

describe('classifyVictory', () => {
  const classify = (
    margin: bigint,
    winnerConfidence: Parameters<typeof classifyVictory>[0]['winnerConfidence'],
    wasComeback = false,
  ) => classifyVictory({ margin, winnerConfidence, wasComeback, thresholds: THRESHOLDS });

  it('labels upsets from the winner’s pre-battle confidence', () => {
    // §11: an underdog win is an UPSET VICTORY, a heavy-underdog win a MAJOR
    // UPSET, regardless of how large the margin turned out to be.
    expect(classify(points(50), 'HEAVY_UNDERDOG')).toBe('MAJOR_UPSET');
    expect(classify(points(1), 'HEAVY_UNDERDOG')).toBe('MAJOR_UPSET');
    expect(classify(points(50), 'UNDERDOG')).toBe('UPSET_VICTORY');
  });

  it('ranks an upset above a comeback', () => {
    expect(classify(points(1), 'UNDERDOG', true)).toBe('UPSET_VICTORY');
  });

  it('labels a comeback when the winner was not an underdog', () => {
    expect(classify(points(10), 'FAVORED', true)).toBe('COMEBACK_VICTORY');
  });

  it('labels by margin when nothing else applies', () => {
    expect(classify(points(2), 'EVEN')).toBe('NARROW_VICTORY');
    expect(classify(points(4), 'EVEN')).toBe('NARROW_VICTORY');
    expect(classify(points(10), 'EVEN')).toBe('VICTORY');
    expect(classify(points(30), 'EVEN')).toBe('DECISIVE_VICTORY');
    expect(classify(points(80), 'DOMINANT')).toBe('DECISIVE_VICTORY');
  });

  it('produces a label for every confidence value', () => {
    for (const confidence of CONFIDENCE_LABELS) {
      expect(classify(points(10), confidence)).toBeTruthy();
    }
  });

  it('rejects unordered or negative thresholds', () => {
    expect(() =>
      classifyVictory({
        margin: 0n,
        winnerConfidence: 'EVEN',
        wasComeback: false,
        thresholds: { narrowMargin: points(30), decisiveMargin: points(4) },
      }),
    ).toThrow(RangeError);
    expect(() =>
      classifyVictory({
        margin: 0n,
        winnerConfidence: 'EVEN',
        wasComeback: false,
        thresholds: { narrowMargin: -1n, decisiveMargin: points(4) },
      }),
    ).toThrow(RangeError);
  });
});
