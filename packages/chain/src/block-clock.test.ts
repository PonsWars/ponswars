import { describe, expect, it } from 'vitest';
import { BlockClock } from './block-clock.js';

/** Ten blocks a second from block 0 at time 0, like Robinhood Chain; timestamps in whole seconds. */
const steady = (block: bigint): number => Math.floor(Number(block) / 10) * 1_000;

function counting(time: (block: bigint) => number): {
  clock: BlockClock;
  reads: bigint[];
} {
  const reads: bigint[] = [];
  return {
    clock: new BlockClock((block) => {
      reads.push(block);
      return Promise.resolve(time(block));
    }),
    reads,
  };
}

describe('BlockClock', () => {
  it('places blocks between anchors without reading them', async () => {
    const { clock, reads } = counting(steady);
    clock.remember(0n, 0);
    clock.remember(3_000n, 300_000);

    const times = await clock.timesOf([1_234n, 2_999n, 10n], () => 3_000n);

    expect(times.get(10n)).toBe(1_000);
    expect(times.get(1_234n)).toBe(123_000);
    expect(times.get(2_999n)).toBe(300_000);
    expect(reads).toEqual([]);
  });

  it('reads anchors on a grid when the known ones are too far apart, shared by nearby blocks', async () => {
    const { clock, reads } = counting(steady);
    clock.remember(0n, 0);
    clock.remember(100_000n, 10_000_000);

    const times = await clock.timesOf([50_100n, 50_200n, 52_900n], () => 3_000n);

    expect(reads).toEqual([48_000n, 51_000n, 54_000n]);
    expect(times.get(50_100n)).toBe(steady(50_100n));
    expect(times.get(52_900n)).toBe(steady(52_900n));
  });

  it('stays close when block production is uneven between anchors', async () => {
    // A sequencer that slows to five blocks a second for the second half.
    const uneven = (block: bigint): number =>
      block <= 1_500n ? Number(block) * 100 : 150_000 + (Number(block) - 1_500) * 200;
    const { clock } = counting(uneven);
    clock.remember(0n, 0);
    clock.remember(3_000n, uneven(3_000n));

    const [estimate] = (await clock.timesOf([1_500n], () => 3_000n)).values();
    expect(Math.abs((estimate ?? 0) - uneven(1_500n))).toBeLessThanOrEqual(75_000);

    // A finer spacing reads closer anchors and closes the gap.
    const [fine] = (await clock.timesOf([1_499n], () => 100n)).values();
    expect(Math.abs((fine ?? 0) - uneven(1_499n))).toBeLessThanOrEqual(1_000);
  });

  it('reads a block outside every anchor rather than extrapolating', async () => {
    const { clock, reads } = counting(steady);
    clock.remember(1_000n, steady(1_000n));

    const times = await clock.timesOf([5_000n], () => 3_000n);

    expect(reads).toEqual([5_000n]);
    expect(times.get(5_000n)).toBe(500_000);
  });

  it('forgets old anchors but keeps one to interpolate from', async () => {
    const { clock } = counting(steady);
    for (const block of [0n, 1_000n, 2_000n, 3_000n]) {
      clock.remember(block, steady(block));
    }

    clock.forgetBefore(250_000);

    expect(clock.size).toBe(2);
    expect((await clock.timesOf([2_500n], () => 3_000n)).get(2_500n)).toBe(250_000);
  });
});
