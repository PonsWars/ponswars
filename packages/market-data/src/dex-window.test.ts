import { RATIO_SCALE } from '@ponswars/battle-math';
import { utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import type { DexTrade } from './dex-price.js';
import {
  minuteBars,
  notionalIn,
  relativeVolume,
  volatilityOver,
  windowReturn,
  type Span,
} from './dex-window.js';

const UNITS = { quoteDecimals: 6, tokenDecimals: 18 };
const DOLLAR = 1_000_000n;
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

let sequence = 0;
function trade(usdPerToken: number, tokens: number, at: number): DexTrade {
  sequence += 1;
  return {
    eventId: `e${String(sequence).padStart(6, '0')}`,
    poolId: 'pool',
    blockNumber: sequence,
    at: utcTimestamp(at),
    quoteAmount: BigInt(Math.round(usdPerToken * tokens * 1_000_000)),
    tokenAmount: BigInt(Math.round(tokens * 1_000_000)) * 10n ** 12n,
  };
}

const span = (from: number, to: number): Span => ({
  from: utcTimestamp(from),
  to: utcTimestamp(to),
});

describe('windowReturn', () => {
  it('is signed and at the ratio scale', () => {
    expect(windowReturn(200n, 202n)).toBe(10_000n);
    expect(windowReturn(200n, 198n)).toBe(-10_000n);
  });

  it('refuses to measure from nothing', () => {
    expect(() => windowReturn(0n, 1n)).toThrow(RangeError);
  });
});

describe('notionalIn', () => {
  it('counts only large-enough trades inside the half-open span', () => {
    const trades = [trade(100, 1, T0), trade(100, 1, T0 + 5_000), trade(100, 0.01, T0 + 6_000)];
    trades.push(trade(100, 1, T0 + 10_000));
    expect(notionalIn(trades, span(T0, T0 + 10_000), 10n * DOLLAR)).toBe(200n * DOLLAR);
  });
});

describe('minuteBars and volatilityOver', () => {
  it('reads nothing from a still market, and falls back to the floor', () => {
    const trades = Array.from({ length: 10 }, (_, index) => trade(100, 1, T0 + index * MINUTE));
    const bars = minuteBars(trades, span(T0, T0 + 10 * MINUTE), UNITS, DOLLAR);
    expect(bars).toHaveLength(10);
    expect(volatilityOver(bars, 9 * MINUTE, 500n)).toBe(500n);
  });

  it('scales a per-minute move by the square root of the horizon', () => {
    // Alternating ±1% every minute: a per-minute RMS of 1%.
    const trades = Array.from({ length: 21 }, (_, index) =>
      trade(index % 2 === 0 ? 100 : 101, 1, T0 + index * MINUTE),
    );
    const bars = minuteBars(trades, span(T0, T0 + 21 * MINUTE), UNITS, DOLLAR);
    const oneMinute = volatilityOver(bars, MINUTE, 1n);
    const nineMinutes = volatilityOver(bars, 9 * MINUTE, 1n);
    // Within rounding of 3× (sqrt 9).
    expect(Number(nineMinutes)).toBeGreaterThan(Number(oneMinute) * 2.99);
    expect(Number(nineMinutes)).toBeLessThan(Number(oneMinute) * 3.01);
    expect(Number(oneMinute)).toBeGreaterThan(9_800);
    expect(Number(oneMinute)).toBeLessThan(10_000);
  });

  it('spreads a return across a quiet gap rather than counting it as one minute', () => {
    const steady = [trade(100, 1, T0), trade(102, 1, T0 + MINUTE)];
    const gapped = [trade(100, 1, T0), trade(102, 1, T0 + 4 * MINUTE)];
    const whole = span(T0, T0 + 10 * MINUTE);
    const steadyVol = volatilityOver(minuteBars(steady, whole, UNITS, DOLLAR), MINUTE, 1n);
    const gappedVol = volatilityOver(minuteBars(gapped, whole, UNITS, DOLLAR), MINUTE, 1n);
    expect(gappedVol).toBeLessThan(steadyVol);
  });
});

describe('relativeVolume', () => {
  const DAY = 86_400_000;
  const today = span(T0, T0 + 9 * MINUTE);
  const earlier = [
    span(T0 - DAY, T0 - DAY + 9 * MINUTE),
    span(T0 - 2 * DAY, T0 - 2 * DAY + 9 * MINUTE),
  ];

  it('is exactly 1× when today traded what the comparable days did on average', () => {
    const trades = [
      trade(100, 2, T0 + MINUTE),
      trade(100, 1, T0 - DAY + MINUTE),
      trade(100, 3, T0 - 2 * DAY + MINUTE),
    ];
    const actual = notionalIn(trades, today, DOLLAR);
    const comparable = earlier.map((span) => notionalIn(trades, span, DOLLAR));
    expect(relativeVolume(actual, comparable, DOLLAR)).toBe(RATIO_SCALE);
  });

  it('measures against the floor when the history is thinner than it', () => {
    expect(relativeVolume(100n * DOLLAR, [0n, 0n], 50n * DOLLAR)).toBe(2n * RATIO_SCALE);
  });
});
