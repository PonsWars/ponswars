import {
  baseUnits,
  MIN_QUALIFYING_WP,
  parseDecimalToBaseUnits,
  rewardWeight,
  tokenDecimals,
  type BaseUnits,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { allocateDistribution, type WalletStanding } from './allocation.js';

const SPY = tokenDecimals(6);
const spy = (decimal: string): BaseUnits => parseDecimalToBaseUnits(decimal, SPY);
const DUST = spy('0.001');

const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

const standing = (n: number, windowWarPoints: number): WalletStanding => ({
  wallet: wallet(n),
  windowWarPoints,
});

const run = (
  poolBalance: BaseUnits,
  standings: readonly WalletStanding[],
  minimumClaim: BaseUnits = DUST,
) => allocateDistribution({ poolBalance, standings, minimumClaim });

describe('conservation', () => {
  it('never creates or loses value, whatever the input', () => {
    // The single most important property in this package. Everything the pool
    // holds is either allocated to a wallet or carried forward - never both,
    // never neither.
    const cases: [BaseUnits, WalletStanding[]][] = [
      [spy('1000'), [standing(1, 100), standing(2, 200), standing(3, 50)]],
      [spy('1000'), []],
      [spy('0'), [standing(1, 100)]],
      [spy('1'), Array.from({ length: 500 }, (_, i) => standing(i + 1, 50 + i))],
      [spy('0.000001'), [standing(1, 999)]],
      [spy('1000'), [standing(1, 1_000_000)]],
      [spy('1000'), Array.from({ length: 3 }, (_, i) => standing(i + 1, 50))],
    ];

    for (const [pool, standings] of cases) {
      const result = run(pool, standings);
      const paid = result.allocations.reduce((sum, a) => sum + a.amount, 0n);
      expect(paid + result.carriedForward).toBe(pool);
      expect(result.totalAllocated).toBe(paid);
      expect(result.carriedForward).toBeGreaterThanOrEqual(0n);
    }
  });

  it('never allocates more than the distributable share', () => {
    const result = run(spy('1000'), [standing(1, 100), standing(2, 100)]);
    expect(result.totalAllocated).toBeLessThanOrEqual(result.distributable);
  });

  it('always retains at least the 20 percent buffer', () => {
    // §16.3: 80% distributable, 20% buffer. The buffer is a floor on what
    // carries forward, never something an allocation can eat into.
    const pool = spy('1000');
    const result = run(
      pool,
      Array.from({ length: 40 }, (_, i) => standing(i + 1, 100)),
    );
    expect(result.carriedForward).toBeGreaterThanOrEqual(pool - result.distributable);
  });
});

describe('the 80/20 split', () => {
  it('makes exactly 80 percent distributable', () => {
    const result = run(spy('1000'), [standing(1, 100)]);
    expect(result.distributable).toBe(spy('800'));
  });
});

describe('qualification', () => {
  it('drops wallets below fifty window war points', () => {
    // §16.4.
    const result = run(spy('1000'), [standing(1, 49), standing(2, 50), standing(3, 51)]);
    expect(result.allocations.map((a) => a.wallet)).toEqual([wallet(3), wallet(2)]);
    expect(result.unqualifiedWalletCount).toBe(1);
    expect(MIN_QUALIFYING_WP).toBe(50);
  });

  it('carries the whole pool forward when nobody qualifies', () => {
    // Not an error state. A quiet window simply rolls its pool into the next.
    const result = run(spy('1000'), [standing(1, 10), standing(2, 20)]);
    expect(result.allocations).toHaveLength(0);
    expect(result.carriedForward).toBe(spy('1000'));
    expect(result.totalAllocated).toBe(0n);
  });

  it('carries the pool forward when there are no standings at all', () => {
    const result = run(spy('1000'), []);
    expect(result.carriedForward).toBe(spy('1000'));
  });

  it('handles an empty pool with qualified wallets', () => {
    const result = run(spy('0'), [standing(1, 100)]);
    expect(result.totalAllocated).toBe(0n);
    expect(result.carriedForward).toBe(0n);
  });
});

describe('sqrt weighting', () => {
  it('weights each wallet by the square root of its war points', () => {
    const result = run(spy('1000'), [standing(1, 100), standing(2, 400)]);
    const first = result.allocations.find((a) => a.wallet === wallet(1));
    const second = result.allocations.find((a) => a.wallet === wallet(2));
    expect(first?.weight).toBe(rewardWeight(100));
    expect(second?.weight).toBe(rewardWeight(400));
    // Four times the points, twice the weight.
    expect(second?.weight).toBe((first?.weight ?? 0n) * 2n);
  });

  it('compresses the gap between a grinder and a casual qualifier', () => {
    // §16.5: the point of sqrt weighting. 16x the war points earns 4x the
    // reward, not 16x.
    //
    // The field is padded to 200 wallets so the 2% cap does not bind either of
    // the two under test - with only two wallets both would cap at 2% and the
    // ratio would read 1.0, measuring the cap instead of the weighting.
    const filler = Array.from({ length: 200 }, (_, i) => standing(i + 3, 200));
    const result = run(spy('10000'), [standing(1, 50), standing(2, 800), ...filler]);
    const low = result.allocations.find((a) => a.wallet === wallet(1))?.amount ?? 0n;
    const high = result.allocations.find((a) => a.wallet === wallet(2))?.amount ?? 0n;
    const ratio = Number(high) / Number(low);
    expect(ratio).toBeGreaterThan(3.9);
    expect(ratio).toBeLessThan(4.1);
  });

  it('pays more war points more reward', () => {
    const result = run(spy('10000'), [
      standing(1, 50),
      standing(2, 100),
      standing(3, 500),
      standing(4, 2_000),
    ]);
    const amounts = result.allocations.map((a) => a.amount);
    for (let i = 0; i < amounts.length - 1; i += 1) {
      expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i + 1] ?? 0n);
    }
  });
});

describe('the two percent cap', () => {
  it('caps a dominant wallet and marks it', () => {
    // §16.6. One wallet with overwhelming war points against many small ones.
    const standings = [
      standing(1, 1_000_000),
      ...Array.from({ length: 60 }, (_, i) => standing(i + 2, 50)),
    ];
    const result = run(spy('10000'), standings);
    const whale = result.allocations.find((a) => a.wallet === wallet(1));

    expect(whale?.capped).toBe(true);
    expect(whale?.amount).toBe(spy('160')); // 2% of the 8000 distributable
    expect(result.cappedWalletCount).toBeGreaterThanOrEqual(1);
  });

  it('redistributes the excess to everyone else', () => {
    // The capped wallet's surplus is not stranded: it raises what the others
    // receive relative to a run where the whale is absent.
    const others = Array.from({ length: 60 }, (_, i) => standing(i + 2, 50));
    const withWhale = run(spy('10000'), [standing(1, 1_000_000), ...others]);
    const withoutWhale = run(spy('10000'), others);

    const pick = (r: ReturnType<typeof run>) =>
      r.allocations.find((a) => a.wallet === wallet(2))?.amount ?? 0n;

    // Without the whale the others split everything; with the whale capped at
    // 2%, they split the remaining 98%. So each gets slightly less, but far
    // more than a proportional split against the whale's raw weight.
    expect(pick(withWhale)).toBeGreaterThan(0n);
    expect(pick(withWhale)).toBeLessThan(pick(withoutWhale));
    expect(Number(pick(withWhale)) / Number(pick(withoutWhale))).toBeGreaterThan(0.9);
  });

  it('caps every wallet when there are too few to absorb the pool', () => {
    // Three qualified wallets cannot each take 2%; the cap binds all of them
    // and the remainder carries forward rather than being force-fed to someone.
    const result = run(spy('10000'), [standing(1, 100), standing(2, 100), standing(3, 100)]);
    expect(result.cappedWalletCount).toBe(3);
    for (const allocation of result.allocations) {
      expect(allocation.amount).toBe(spy('160'));
    }
    const paid = result.allocations.reduce((sum, a) => sum + a.amount, 0n);
    expect(paid + result.carriedForward).toBe(spy('10000'));
    expect(result.carriedForward).toBeGreaterThan(spy('2000'));
  });

  it('never pays any wallet more than the cap', () => {
    // Checked across shapes that stress the redistribution loop.
    const shapes: WalletStanding[][] = [
      [standing(1, 10_000), standing(2, 50)],
      [standing(1, 10_000), standing(2, 9_000), standing(3, 50)],
      Array.from({ length: 51 }, (_, i) => standing(i + 1, i === 0 ? 1_000_000 : 50)),
      Array.from({ length: 200 }, (_, i) => standing(i + 1, 50 + i * 37)),
    ];
    for (const standings of shapes) {
      const result = run(spy('10000'), standings);
      const cap = (result.distributable * 200n) / 10_000n;
      for (const allocation of result.allocations) {
        expect(allocation.amount).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('leaves nobody capped when the field is wide enough', () => {
    const result = run(
      spy('10000'),
      Array.from({ length: 200 }, (_, i) => standing(i + 1, 50 + i)),
    );
    expect(result.cappedWalletCount).toBe(0);
  });
});

describe('the minimum claim threshold', () => {
  it('carries a below-threshold amount forward instead of paying dust', () => {
    // §16.7: rewards below the threshold carry forward rather than forcing
    // dust claims. The amount is not forfeited.
    const standings = Array.from({ length: 400 }, (_, i) => standing(i + 1, 50));
    const result = run(spy('0.1'), standings, spy('0.001'));

    const carriedByWallets = result.allocations.reduce((sum, a) => sum + a.carriedForward, 0n);
    expect(carriedByWallets).toBeGreaterThan(0n);
    for (const allocation of result.allocations) {
      if (allocation.amount > 0n) {
        expect(allocation.amount).toBeGreaterThanOrEqual(spy('0.001'));
      } else {
        expect(allocation.carriedForward).toBeGreaterThan(0n);
      }
    }
    const paid = result.allocations.reduce((sum, a) => sum + a.amount, 0n);
    expect(paid + result.carriedForward).toBe(spy('0.1'));
  });

  it('pays everyone when the threshold is zero', () => {
    const result = run(spy('1000'), [standing(1, 100), standing(2, 100)], baseUnits(0n));
    for (const allocation of result.allocations) {
      expect(allocation.carriedForward).toBe(0n);
    }
  });
});

describe('determinism', () => {
  it('produces an identical result for identical input', () => {
    // A distribution becomes a Merkle root. Two runs over the same snapshot
    // must agree exactly, or the published root is not reproducible.
    const standings = Array.from({ length: 50 }, (_, i) => standing(i + 1, 50 + i * 13));
    expect(run(spy('1000'), standings)).toEqual(run(spy('1000'), standings));
  });

  it('is independent of the order rows arrive in', () => {
    // Database row order is not guaranteed. If it changed the allocation, the
    // same snapshot could produce two different roots.
    const standings = Array.from({ length: 30 }, (_, i) => standing(i + 1, 50 + i * 7));
    const shuffled = [...standings].reverse();
    expect(run(spy('1000'), shuffled)).toEqual(run(spy('1000'), standings));
  });

  it('orders equal-war-point wallets by address', () => {
    const result = run(spy('1000'), [standing(3, 100), standing(1, 100), standing(2, 100)]);
    expect(result.allocations.map((a) => a.wallet)).toEqual([wallet(1), wallet(2), wallet(3)]);
  });
});

describe('input validation', () => {
  it('rejects a negative pool', () => {
    expect(() => run(baseUnits(-1n), [])).toThrow(RangeError);
  });

  it('rejects a negative claim threshold', () => {
    expect(() => run(spy('1'), [], baseUnits(-1n))).toThrow(RangeError);
  });

  it('rejects a duplicated wallet', () => {
    // A wallet appearing twice would be paid twice. §49.10 makes the ledger
    // idempotent per wallet; this is the same rule at the allocation boundary.
    expect(() => run(spy('1'), [standing(1, 100), standing(1, 200)])).toThrow(RangeError);
  });

  it('rejects fractional or negative war points', () => {
    expect(() => run(spy('1'), [{ wallet: wallet(1), windowWarPoints: 1.5 }])).toThrow(RangeError);
    expect(() => run(spy('1'), [{ wallet: wallet(1), windowWarPoints: -1 }])).toThrow(RangeError);
  });
});
