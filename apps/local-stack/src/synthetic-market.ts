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
 * It is a *walk*, and the first version was not. Drawing an independent sample
 * each step made the lead flip every fifteen seconds, and the first live round
 * finished with four of five battles labelled `COMEBACK_VICTORY` — the engine
 * reading whipsaw exactly as §13.3 says it should, from a market that no real
 * market resembles. Accumulating the steps is what makes a session look like
 * something worth watching rather than a coin flipped on a timer.
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
  /**
   * How many steps of history each observation accumulates.
   *
   * The walk is summed over a bounded window rather than from the beginning of
   * time, so a session left running overnight does not wander somewhere
   * absurd. Forty steps at fifteen seconds is ten minutes — one round.
   */
  readonly windowSteps: number;
  /**
   * Half-width of one step's increment, in scaled return units.
   *
   * Sets how far a battle can pull apart over a round, and so which victory
   * labels a session produces at all. Measured rather than chosen — see
   * `DEFAULT_SYNTHETIC_MARKET`.
   */
  readonly stepRange: number;
}

/**
 * Settings measured against the real engine, not chosen by taste.
 *
 * `stepRange` is the one that had to be measured. Two hundred battles were run
 * through the round loop at each candidate and the victory labels counted:
 *
 * |  range | VICTORY | NARROW | DECISIVE | COMEBACK |
 * | -----: | ------: | -----: | -------: | -------: |
 * |    500 |     58% |    42% |       0% |       0% |
 * | *1200* | *70%*   | *21%*  |     *6%* |     *4%* |
 * |   1500 |     68% |     9% |      10% |      14% |
 * |   2000 |     52% |     6% |      20% |      22% |
 *
 * At 500 the walk is too smooth to ever pull a battle apart, so half the
 * vocabulary in §13.6 never appears. At 2000 more than a fifth of battles are
 * comebacks, which is the earlier whipsaw returning in a milder form — a
 * comeback that common is not a comeback. 1200 keeps all four labels and keeps
 * the rare ones rare.
 *
 * `UPSET_VICTORY` and `MAJOR_UPSET` appear in none of them, and should not:
 * §11 derives them from the winner's pre-battle confidence, which `main.ts`
 * fixes at `EVEN` so that nothing local reads as an assessment of a real stock.
 * They are unreachable here by design, not missing.
 */
export const DEFAULT_SYNTHETIC_MARKET: SyntheticMarketOptions = {
  seedHex: `0x${'5c'.repeat(32)}`,
  stepMs: 15_000,
  degradedBps: 0,
  windowSteps: 40,
  stepRange: 1_200,
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

    // The walk: each step's increment is small and the observation is their
    // sum, so a direction persists across ticks instead of being redrawn. No
    // ticker carries a fixed bias, because §12.1 divides the return by the
    // asset's own volatility and a structural edge would defeat that.
    const drift = this.driftAt(step, ticker);
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

  /** The accumulated walk at a step, summed over the bounded window. */
  private driftAt(step: number, ticker: ActiveTicker): bigint {
    let drift = 0n;
    const first = step - this.options.windowSteps + 1;
    for (let index = first; index <= step; index += 1) {
      const prng = new DeterministicPrng(this.options.seedHex, `WALK|${String(index)}|${ticker}`);
      drift += BigInt(prng.nextBelow(this.options.stepRange * 2 + 1) - this.options.stepRange);
    }
    return drift;
  }
}
