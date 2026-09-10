import { ACTIVE_TICKERS, utcTimestamp, type ActiveTicker } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNTHETIC_MARKET, SyntheticMarket } from './synthetic.js';

/**
 * That the synthetic market behaves like a market.
 *
 * These exist because the first version did not, and nothing caught it until a
 * live round finished with four of five battles labelled `COMEBACK_VICTORY`.
 * The engine was right; the market was a coin flipped every fifteen seconds,
 * and a lead that reverses that often makes every battle a comeback.
 */

const START = utcTimestamp(1_800_000_000_000);
const market = new SyntheticMarket();

/** Drift sampled once per step across a round-length window. */
async function walk(steps: number, ticker: ActiveTicker = 'NVDA'): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < steps; index += 1) {
    const at = utcTimestamp(START + index * DEFAULT_SYNTHETIC_MARKET.stepMs);
    values.push(Number((await market.observe(ticker, at)).inputs.windowReturn));
  }
  return values;
}

describe('the walk', () => {
  it('persists rather than redrawing each step', async () => {
    // The property that was missing: consecutive steps differ by one increment,
    // not by a whole new sample. A redrawn market would move by up to the full
    // range every step.
    const values = await walk(40);
    const jumps = values.slice(1).map((value, index) => Math.abs(value - values[index]!));
    // Two increments: the window gains one step and drops another.
    expect(Math.max(...jumps)).toBeLessThanOrEqual(2 * DEFAULT_SYNTHETIC_MARKET.stepRange);
  });

  it('travels far enough over a round to separate a battle', async () => {
    // The opposite failure to whipsaw, and the one the first fix caused: a walk
    // too small to pull a battle apart leaves every result NARROW or plain
    // VICTORY, and half the vocabulary in §13.6 never appears.
    //
    // Measured across ten tickers rather than checked on one, because a single
    // walk's peak is too noisy to separate the two settings — over sixty round
    // windows the flattened walk reached 3921 on this statistic and the current
    // one fell no lower than 5102, so 4500 divides them everywhere. A bound
    // written against `stepRange` would shrink with it and pass either way,
    // which is a test agreeing with whatever the code does.
    const peaks = await Promise.all(
      ACTIVE_TICKERS.map(async (ticker) => Math.max(...(await walk(40, ticker)).map(Math.abs))),
    );
    peaks.sort((left, right) => left - right);

    expect(peaks[Math.floor(peaks.length / 2)]).toBeGreaterThan(4_500);
  });

  it('holds a direction long enough to be a direction', async () => {
    // Forty steps is one round. A market whose sign flips on most of them is
    // the whipsaw that made every battle a comeback.
    const values = await walk(40);
    const flips = values
      .slice(1)
      .filter((value, index) => Math.sign(value) !== Math.sign(values[index]!)).length;
    expect(flips).toBeLessThan(10);
  });

  it('is stable within a step and moves between them', async () => {
    // The cadence is coarser than the tick rate on purpose: observations inside
    // one step agree, so a second of ticks does not shake the frontline.
    const early = await market.observe('NVDA', utcTimestamp(START + 1_000));
    const late = await market.observe('NVDA', utcTimestamp(START + 14_000));
    const next = await market.observe('NVDA', utcTimestamp(START + 16_000));

    expect(late.inputs.windowReturn).toBe(early.inputs.windowReturn);
    expect(next.inputs.windowReturn).not.toBe(early.inputs.windowReturn);
  });
});

describe('determinism', () => {
  it('gives the same observation for the same instant', async () => {
    // Seeded, like everything else here. A market that differed between two
    // reads of the same moment would make a local session unreproducible.
    const first = await market.observe('AAPL', utcTimestamp(START + 60_000));
    const second = await market.observe('AAPL', utcTimestamp(START + 60_000));
    expect(second).toEqual(first);
  });

  it('gives different tickers different streams', async () => {
    const nvda = await market.observe('NVDA', utcTimestamp(START + 60_000));
    const aapl = await market.observe('AAPL', utcTimestamp(START + 60_000));
    expect(nvda.inputs.windowReturn).not.toBe(aapl.inputs.windowReturn);
  });
});

describe('what it refuses to invent', () => {
  it('reports no card support', async () => {
    // §12.4 makes card support a player-driven input aggregated from real
    // deployments. A market has no business producing it, and a synthetic one
    // producing it would make the card contribution look like market signal.
    const observation = await market.observe('NVDA', START);
    expect(observation.inputs.cardSupport).toEqual({
      market: 0n,
      volume: 0n,
      pons: 0n,
      general: 0n,
    });
  });

  it('reports a healthy feed unless asked for degradation', async () => {
    expect((await market.observe('NVDA', START)).health).toBe('HEALTHY');
  });

  it('still produces numbers when the feed is degraded', async () => {
    // §23.6: degraded data is late but real. Only the label changes, because
    // that is the distinction the engine acts on.
    const flaky = new SyntheticMarket({ ...DEFAULT_SYNTHETIC_MARKET, degradedBps: 10_000 });
    const observation = await flaky.observe('NVDA', START);

    expect(observation.health).toBe('DEGRADED');
    expect(observation.inputs.relativeVolume).toBeGreaterThan(0n);
  });
});
