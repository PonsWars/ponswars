import { utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  deviationBps,
  priceAt,
  PRICE_SCALE,
  tradePrice,
  weightedMedianPrice,
  type DexTrade,
  type PricePolicy,
  type ReferencePrice,
} from './dex-price.js';

/** USDG has 6 decimals and Stock Tokens 18, as on Robinhood Chain. */
const UNITS = { quoteDecimals: 6, tokenDecimals: 18 };
const DOLLAR = 1_000_000n;
const TOKEN = 10n ** 18n;
const NOW = utcTimestamp(1_800_000_000_000);

const POLICY: PricePolicy = {
  priceWindowMs: 60_000,
  maxQuietMs: 600_000,
  minTradeQuote: 10n * DOLLAR,
  maxTradeDeviationBps: 300n,
  maxPriceDeviationBps: 150n,
  maxReferenceAgeMs: 86_400_000,
  minWindowTrades: 3,
};

let sequence = 0;
/** A trade of `tokens` at `usdPerToken`, `ago` milliseconds before now. */
function trade(usdPerToken: number, tokens: number, ago: number): DexTrade {
  sequence += 1;
  return {
    eventId: `0x${sequence.toString(16).padStart(8, '0')}:0`,
    poolId: 'pool',
    blockNumber: 1_000 + sequence,
    at: utcTimestamp(NOW - ago),
    quoteAmount: BigInt(Math.round(usdPerToken * tokens * 1_000_000)),
    tokenAmount: BigInt(Math.round(tokens * 1_000_000)) * 10n ** 12n,
  };
}

const usd = (value: number): bigint => BigInt(Math.round(value * 100)) * (PRICE_SCALE / 100n);
const REFERENCE: ReferencePrice = { price: usd(200), updatedAt: utcTimestamp(NOW - 3_600_000) };

describe('tradePrice', () => {
  it('turns a dollar amount and a token amount into USD at the price scale', () => {
    expect(
      tradePrice({ ...trade(0, 0, 0), quoteAmount: 421n * DOLLAR, tokenAmount: 2n * TOKEN }, UNITS),
    ).toBe(usd(210.5));
  });

  it('refuses a trade with no token side', () => {
    expect(() => tradePrice({ ...trade(1, 1, 0), tokenAmount: 0n }, UNITS)).toThrow(RangeError);
  });
});

describe('weightedMedianPrice', () => {
  it('sits where half the notional is, so one large outlier cannot move it', () => {
    const median = weightedMedianPrice([
      { price: 100n, weight: 10n, id: 'a' },
      { price: 101n, weight: 10n, id: 'b' },
      { price: 102n, weight: 10n, id: 'c' },
      // Larger than any one trade, smaller than the rest together.
      { price: 900n, weight: 25n, id: 'd' },
    ]);
    expect(median).toBe(102n);
  });

  it('is independent of the order trades arrive in', () => {
    const entries = [
      { price: 5n, weight: 1n, id: 'x' },
      { price: 3n, weight: 2n, id: 'y' },
      { price: 4n, weight: 1n, id: 'z' },
    ];
    expect(weightedMedianPrice(entries)).toBe(weightedMedianPrice([...entries].reverse()));
  });

  it('has no answer for no trades', () => {
    expect(weightedMedianPrice([])).toBeNull();
  });
});

describe('deviationBps', () => {
  it('measures either direction against the reference', () => {
    expect(deviationBps(102n, 100n)).toBe(200n);
    expect(deviationBps(98n, 100n)).toBe(200n);
  });
});

describe('priceAt', () => {
  it('is HEALTHY with enough trades near the reference', () => {
    const reading = priceAt(
      [trade(200.2, 1, 1_000), trade(199.9, 1, 5_000), trade(200.1, 2, 20_000)],
      NOW,
      UNITS,
      REFERENCE,
      POLICY,
    );
    expect(reading.health).toBe('HEALTHY');
    expect(reading.price).toBe(usd(200.1));
    expect(reading.trades).toBe(3);
  });

  it('ignores dust, however far it would have moved the price', () => {
    const reading = priceAt(
      [trade(200, 1, 1_000), trade(200, 1, 2_000), trade(200, 1, 3_000), trade(260, 0.01, 500)],
      NOW,
      UNITS,
      REFERENCE,
      POLICY,
    );
    expect(reading.price).toBe(usd(200));
    expect(reading.trades).toBe(3);
  });

  it('drops a trade far from the reference as an outlier rather than pricing from it', () => {
    const reading = priceAt(
      [trade(200, 1, 1_000), trade(201, 1, 2_000), trade(199, 1, 3_000), trade(400, 50, 500)],
      NOW,
      UNITS,
      REFERENCE,
      POLICY,
    );
    expect(reading.health).toBe('HEALTHY');
    expect(reading.price).toBe(usd(200));
  });

  it('is STALE when the counted trades still disagree with the reference', () => {
    // Every trade within the outlier bound, but all on one side of it: the
    // market and its reference no longer describe the same thing.
    const reading = priceAt(
      [trade(205, 1, 1_000), trade(205.5, 1, 2_000), trade(205.2, 1, 3_000)],
      NOW,
      UNITS,
      REFERENCE,
      POLICY,
    );
    expect(reading.health).toBe('STALE');
    expect(reading.note).toBe('REFERENCE_DIVERGENCE');
  });

  it('carries the last price, DEGRADED, through a quiet spell', () => {
    const reading = priceAt([trade(200.5, 1, 120_000)], NOW, UNITS, REFERENCE, POLICY);
    expect(reading.health).toBe('DEGRADED');
    expect(reading.note).toBe('CARRIED');
    expect(reading.price).toBe(usd(200.5));
    expect(reading.trades).toBe(0);
  });

  it('is STALE once the last trade is older than the quiet limit', () => {
    const reading = priceAt([trade(200, 1, 700_000)], NOW, UNITS, REFERENCE, POLICY);
    expect(reading.health).toBe('STALE');
    expect(reading.price).toBeNull();
  });

  it('never prices from a trade after the instant', () => {
    const reading = priceAt([trade(200, 1, -5_000)], NOW, UNITS, REFERENCE, POLICY);
    expect(reading.price).toBeNull();
  });

  it('is DEGRADED when thin, and when nothing independent can vouch for it', () => {
    expect(priceAt([trade(200, 1, 1_000)], NOW, UNITS, REFERENCE, POLICY).note).toBe('THIN');

    const stale = { ...REFERENCE, updatedAt: utcTimestamp(NOW - 90_000_000) };
    const unvouched = priceAt(
      [trade(200, 1, 1_000), trade(200, 1, 2_000), trade(200, 1, 3_000)],
      NOW,
      UNITS,
      stale,
      POLICY,
    );
    expect(unvouched.health).toBe('DEGRADED');
    expect(unvouched.note).toBe('NO_REFERENCE');
  });
});
