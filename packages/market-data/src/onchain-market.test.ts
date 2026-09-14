import { RATIO_SCALE } from '@ponswars/battle-math';
import type { NormalizedActivity } from '@ponswars/pons-indexer';
import {
  utcTimestamp,
  walletAddress,
  type ActiveTicker,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { PRICE_SCALE, type DexTrade, type ReferencePrice } from './dex-price.js';
import type { Span } from './dex-window.js';
import { OnchainMarket, type MarketSource, type OnchainMarketPolicy } from './onchain-market.js';

const DOLLAR = 1_000_000n;
const MINUTE = 60_000;
/** Wednesday 2026-09-16 10:00 New York: the market is open. */
const LOCK = utcTimestamp(Date.parse('2026-09-16T14:00:00Z'));

const POLICY: OnchainMarketPolicy = {
  price: {
    priceWindowMs: MINUTE,
    maxQuietMs: 10 * MINUTE,
    minTradeQuote: DOLLAR,
    maxTradeDeviationBps: 500n,
    maxPriceDeviationBps: 300n,
    maxReferenceAgeMs: 26 * 3_600_000,
    minWindowTrades: 1,
  },
  maxSourceLagMs: 30_000,
  volatilityLookbackMs: 60 * MINUTE,
  volatilityFloor: 1_000n,
  comparableSessions: 2,
  expectedNotionalFloor: DOLLAR,
  confidenceSubWindows: 3,
  pons: {
    minimumAmount: 5n * DOLLAR,
    maxIdenticalPerWallet: 3,
    excludedAddresses: new Set(),
    version: 'test-v1',
  },
  calendar: { holidays: new Set() },
};

let sequence = 0;
function trade(usdPerToken: number, at: number, tokens = 1): DexTrade {
  sequence += 1;
  return {
    eventId: `0x${sequence.toString(16).padStart(6, '0')}:0`,
    poolId: 'pool',
    blockNumber: sequence,
    at: utcTimestamp(at),
    quoteAmount: BigInt(Math.round(usdPerToken * tokens * 1_000_000)),
    tokenAmount: BigInt(Math.round(tokens * 1_000_000)) * 10n ** 12n,
  };
}

function activity(wallet: string, dollars: number, at: number): NormalizedActivity {
  sequence += 1;
  return {
    eventId: `0x${sequence.toString(16).padStart(6, '0')}:1`,
    wallet: walletAddress(wallet),
    ticker: 'NVDA',
    amount: BigInt(dollars) * DOLLAR,
    blockNumber: sequence,
    at: utcTimestamp(at),
  };
}

class ArraySource implements MarketSource {
  constructor(
    private readonly all: readonly DexTrade[],
    private readonly pons: readonly NormalizedActivity[] = [],
    private readonly ref: ReferencePrice | null = {
      price: 100n * PRICE_SCALE,
      updatedAt: utcTimestamp(LOCK - 3_600_000),
    },
    private readonly covered: UtcTimestamp = utcTimestamp(Number.MAX_SAFE_INTEGER),
  ) {}
  trades(_ticker: ActiveTicker, span: Span): readonly DexTrade[] {
    return this.all.filter((entry) => entry.at >= span.from && entry.at < span.to);
  }
  ponsActivity(_ticker: ActiveTicker, span: Span): readonly NormalizedActivity[] {
    return this.pons.filter((entry) => entry.at >= span.from && entry.at < span.to);
  }
  reference(): ReferencePrice | null {
    return this.ref;
  }
  units() {
    return { quoteDecimals: 6, tokenDecimals: 18 };
  }
  coversUntil(): UtcTimestamp {
    return this.covered;
  }
}

const WALLET_A = '0x00000000000000000000000000000000000000aa';
const WALLET_B = '0x00000000000000000000000000000000000000bb';

describe('OnchainMarket.observe', () => {
  it('scores the return since lock, the volume against earlier days and qualified Pons activity', async () => {
    const DAY = 86_400_000;
    const trades = [
      trade(100, LOCK - 30_000),
      trade(101, LOCK + 5 * MINUTE - 20_000),
      // The same stretch on the two previous trading days, half as busy.
      trade(100, LOCK - DAY + MINUTE, 0.5),
      trade(100, LOCK - 2 * DAY + MINUTE, 0.5),
    ];
    const pons = [
      activity(WALLET_A, 20, LOCK + MINUTE),
      activity(WALLET_B, 30, LOCK + 2 * MINUTE),
      activity(WALLET_B, 1, LOCK + 3 * MINUTE), // dust
    ];
    const market = new OnchainMarket(new ArraySource(trades, pons), POLICY);

    const observation = await market.observe('NVDA', {
      opensAt: LOCK,
      at: utcTimestamp(LOCK + 5 * MINUTE),
    });

    expect(observation.health).toBe('HEALTHY');
    expect(observation.inputs.windowReturn).toBe(10_000n); // +1%
    // $101 today against $50 on each comparable day.
    expect(observation.inputs.relativeVolume).toBe((101n * RATIO_SCALE) / 50n);
    expect(observation.inputs.qualifiedPonsActivity).toBe(2n);
    expect(observation.inputs.uniqueActiveWallets).toBe(2n);
    expect(observation.inputs.volatility).toBeGreaterThanOrEqual(POLICY.volatilityFloor);
  });

  it('is STALE while the market is shut, whatever the pools are doing', async () => {
    // Saturday 2026-09-19.
    const saturday = utcTimestamp(Date.parse('2026-09-19T15:00:00Z'));
    const market = new OnchainMarket(
      new ArraySource([trade(100, saturday - 1_000), trade(120, saturday - 500)]),
      POLICY,
    );
    const observation = await market.observe('NVDA', {
      opensAt: utcTimestamp(saturday - MINUTE),
      at: saturday,
    });
    expect(observation.health).toBe('STALE');
    expect(observation.inputs.windowReturn).toBe(0n);
  });

  it('is STALE with neutral inputs when there was no price at lock', async () => {
    const market = new OnchainMarket(new ArraySource([trade(100, LOCK + MINUTE)]), POLICY);
    const observation = await market.observe('NVDA', {
      opensAt: LOCK,
      at: utcTimestamp(LOCK + 2 * MINUTE),
    });
    expect(observation.health).toBe('STALE');
    expect(observation.inputs.windowReturn).toBe(0n);
  });

  it('is UNAVAILABLE before the source has read anything, and STALE once it falls behind', async () => {
    const unread = new OnchainMarket(
      new ArraySource([trade(100, LOCK - 1_000)], [], undefined, utcTimestamp(0)),
      POLICY,
    );
    expect((await unread.observe('NVDA', { opensAt: LOCK, at: LOCK })).health).toBe('UNAVAILABLE');

    const behind = new OnchainMarket(
      new ArraySource([trade(100, LOCK - 1_000)], [], undefined, utcTimestamp(LOCK - MINUTE)),
      POLICY,
    );
    expect((await behind.observe('NVDA', { opensAt: LOCK, at: LOCK })).health).toBe('STALE');
  });
});

describe('OnchainMarket.lookback', () => {
  it('reads the fifteen minutes before a round as a return and its path', async () => {
    const trades = [
      trade(100, LOCK - 15 * MINUTE - 1_000),
      trade(102, LOCK - 10 * MINUTE - 1_000),
      trade(101, LOCK - 5 * MINUTE - 1_000),
      trade(103, LOCK - 1_000),
    ];
    const market = new OnchainMarket(new ArraySource(trades), POLICY);
    const lookback = await market.lookback('NVDA', LOCK);
    expect(lookback.windowReturn).toBe(30_000n);
    expect(lookback.subWindowReturns).toHaveLength(3);
    expect(lookback.subWindowReturns[0]).toBe(20_000n);
    expect(lookback.subWindowReturns[1]).toBeLessThan(0n);
  });
});
