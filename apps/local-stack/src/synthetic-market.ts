import { DeterministicPrng, NO_CARD_SUPPORT } from '@ponswars/battle-math';
import type { MarketDataPort, MarketObservation } from '@ponswars/round-service';
import type { ActiveTicker, UtcTimestamp } from '@ponswars/shared-types';

/**
 * A market that is not a market.
 *
 * **This is not a vendor adapter and must never become one.** Choosing a
 * market-data provider is a commercial and licensing decision — showing
 * real-time prices to visitors who have not logged in is redistribution under
 * most vendor agreements, and priced accordingly — so it stays `OPEN` (§102)
 * until someone decides it. What this does is let the whole loop run locally so
 * the rest of the system can be seen working.
 *
 * It is seeded and continuous rather than seeded and indexed. The simulation's
 * generator keys on round and tick so a run is reproducible; this keys on the
 * clock so a battle drifts while you watch it. Different purposes, so they are
 * different code rather than one generator bent to do both.
 *
 * Every value it returns is shaped exactly like a real observation, because the
 * engine consuming it must not be able to tell the difference. That is what
 * makes swapping in a real vendor a change to one file.
 */

export interface SyntheticMarketOptions {
  readonly seedHex: string;
  /**
   * How often the underlying random walk takes a step, in milliseconds.
   *
   * Coarser than the tick cadence on purpose: a walk that re-rolled on every
   * observation would be noise rather than a trend, and §13 wants a frontline
   * that moves with intent.
   */
  readonly stepMs: number;
  /** Chance in basis points that a given observation reports a degraded feed. */
  readonly degradedBps: number;
}

export const DEFAULT_SYNTHETIC_MARKET: SyntheticMarketOptions = {
  seedHex: `0x${'5c'.repeat(32)}`,
  stepMs: 15_000,
  degradedBps: 0,
};

export class SyntheticMarket implements MarketDataPort {
  constructor(private readonly options: SyntheticMarketOptions = DEFAULT_SYNTHETIC_MARKET) {}

  observe(ticker: ActiveTicker, at: UtcTimestamp): Promise<MarketObservation> {
    const step = Math.floor(at / this.options.stepMs);
    const prng = new DeterministicPrng(this.options.seedHex, `SYNTH|${String(step)}|${ticker}`);

    // A degraded feed is real data arriving late (§23.6), so the numbers are
    // still produced. Only the health label changes, which is the distinction
    // the engine acts on.
    const health = prng.nextBelow(10_000) < this.options.degradedBps ? 'DEGRADED' : 'HEALTHY';

    // A walk around zero rather than a fixed bias, so no ticker is structurally
    // favoured across a session. §12.1 divides the return by the asset's own
    // volatility for the same reason.
    const drift = BigInt(prng.nextBelow(20_001) - 10_000);
    const volume = BigInt(900_000 + prng.nextBelow(400_001));

    return Promise.resolve({
      inputs: {
        windowReturn: drift,
        volatility: 10_000n,
        relativeVolume: volume,
        qualifiedPonsActivity: BigInt(prng.nextBelow(60)),
        uniqueActiveWallets: BigInt(prng.nextBelow(30)),
        // Card support is aggregated from real deployments by the Player
        // service. A synthetic market has no business inventing it — §12.4
        // makes it a player-driven input, not a market one.
        cardSupport: NO_CARD_SUPPORT,
      },
      health,
    });
  }
}
