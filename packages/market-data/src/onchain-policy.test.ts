import { RATIO_SCALE } from '@ponswars/battle-math';
import { describe, expect, it } from 'vitest';
import { onchainMarketPolicy, type OnchainMarketSettings } from './onchain-policy.js';

const SETTINGS: OnchainMarketSettings = {
  PRICE_FEED_STALE_AFTER_MS: 900_000,
  VOLUME_FEED_STALE_AFTER_MS: 60_000,
  PONS_FEED_STALE_AFTER_MS: 20_000,
  MARKET_PRICE_WINDOW_MS: 120_000,
  MARKET_MIN_TRADE_USD: '5',
  MARKET_OUTLIER_BPS: 300,
  MARKET_DIVERGENCE_BPS: 200,
  MARKET_REFERENCE_MAX_AGE_MS: 93_600_000,
  MARKET_MIN_WINDOW_TRADES: 2,
  MARKET_VOLATILITY_LOOKBACK_MS: 1_500_000,
  MARKET_VOLATILITY_FLOOR_BPS: 5,
  MARKET_COMPARABLE_SESSIONS: 5,
  MARKET_EXPECTED_VOLUME_FLOOR_USD: '1000.50',
  MARKET_HOLIDAYS: ['2026-11-26', '2026-12-25'],
  PONS_MIN_ACTIVITY_USD: '0.5',
  PONS_MAX_IDENTICAL_PER_WALLET: 5,
};

describe('onchainMarketPolicy', () => {
  it('reads dollars in the quote token’s own units and basis points at the ratio scale', () => {
    const policy = onchainMarketPolicy(SETTINGS, {
      quoteDecimals: 6,
      excludedAddresses: ['0xABCDEF0000000000000000000000000000000001'],
    });

    expect(policy.price.minTradeQuote).toBe(5_000_000n);
    expect(policy.expectedNotionalFloor).toBe(1_000_500_000n);
    expect(policy.pons.minimumAmount).toBe(500_000n);
    expect(policy.price.maxTradeDeviationBps).toBe(300n);
    // Five basis points is 0.05%.
    expect(policy.volatilityFloor).toBe((RATIO_SCALE * 5n) / 10_000n);
    expect([...policy.pons.excludedAddresses]).toEqual([
      '0xabcdef0000000000000000000000000000000001',
    ]);
    expect(policy.calendar.holidays.size).toBe(2);
  });

  it('believes the source no further behind than the strictest feed allows', () => {
    const policy = onchainMarketPolicy(SETTINGS, { quoteDecimals: 6, excludedAddresses: [] });
    expect(policy.maxSourceLagMs).toBe(20_000);
  });
});
