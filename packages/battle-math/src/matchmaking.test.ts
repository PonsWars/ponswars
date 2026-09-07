import { ACTIVE_TICKERS, BATTLES_PER_ROUND, MATCHUP_COOLDOWN_ROUNDS } from '@ponswars/shared-types';
import type { ActiveTicker } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { cooldownSet, matchupKey, scheduleRound, type Pairing } from './matchmaking.js';

const SEED = '0x9f2c1a77b4e5d6083c1f2a9b8e7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d';

const schedule = (roundId: string, recentRounds: readonly (readonly Pairing[])[] = []) =>
  scheduleRound({ baseSeedHex: SEED, roundId, recentRounds });

const flatten = (pairings: readonly Pairing[]): ActiveTicker[] =>
  pairings.flatMap((pairing) => [pairing.left, pairing.right]);

describe('matchupKey', () => {
  it('is order independent', () => {
    // §4.3 bars the same *unordered* matchup. NVDA vs AAPL and AAPL vs NVDA are
    // one matchup, and a key that distinguished them would let a pairing repeat
    // next round simply by swapping sides.
    expect(matchupKey('NVDA', 'AAPL')).toBe(matchupKey('AAPL', 'NVDA'));
    expect(matchupKey('NVDA', 'AAPL')).not.toBe(matchupKey('NVDA', 'MSFT'));
  });
});

describe('scheduleRound structure', () => {
  const pairings = schedule('round-1');

  it('produces exactly five battles', () => {
    expect(pairings).toHaveLength(BATTLES_PER_ROUND);
  });

  it('uses every active ticker exactly once', () => {
    const used = flatten(pairings);
    expect(used).toHaveLength(ACTIVE_TICKERS.length);
    expect(new Set(used).size).toBe(ACTIVE_TICKERS.length);
    expect([...used].sort()).toEqual([...ACTIVE_TICKERS].sort());
  });

  it('never self-matches', () => {
    for (const pairing of pairings) {
      expect(pairing.left).not.toBe(pairing.right);
    }
  });

  it('holds the same properties across many rounds', () => {
    for (let round = 0; round < 500; round += 1) {
      const result = schedule(`round-${String(round)}`);
      const used = flatten(result);
      expect(result).toHaveLength(BATTLES_PER_ROUND);
      expect(new Set(used).size).toBe(ACTIVE_TICKERS.length);
      for (const pairing of result) {
        expect(pairing.left).not.toBe(pairing.right);
      }
    }
  });
});

describe('determinism', () => {
  it('is reproducible from seed and round alone', () => {
    // §26: a third party must be able to check the pairings were not chosen to
    // favour anyone. That requires the schedule to be a pure function of
    // published inputs.
    expect(schedule('round-42')).toEqual(schedule('round-42'));
  });

  it('differs between rounds on the same base seed', () => {
    const a = schedule('round-1');
    const b = schedule('round-2');
    expect(a).not.toEqual(b);
  });

  it('differs between base seeds for the same round', () => {
    const other = scheduleRound({
      baseSeedHex: '0x1111111111111111111111111111111111111111111111111111111111111111',
      roundId: 'round-1',
    });
    expect(other).not.toEqual(schedule('round-1'));
  });

  it('is insensitive to seed casing and 0x prefix', () => {
    // An uppercased seed is the same seed. This once silently produced a
    // different schedule: `startsWith('0x')` missed the `0X` prefix, and
    // Buffer.from stops at the first unparseable character rather than
    // throwing - so the seed became empty and every round would have shared
    // one schedule. Prefix stripping is case-insensitive and every entry point
    // validates.
    const bare = scheduleRound({ baseSeedHex: SEED.slice(2), roundId: 'round-7' });
    const upper = scheduleRound({ baseSeedHex: SEED.toUpperCase(), roundId: 'round-7' });
    expect(bare).toEqual(schedule('round-7'));
    expect(upper).toEqual(schedule('round-7'));
  });

  it('pins a known schedule so an accidental algorithm change is visible', () => {
    // A golden value. If the derivation changes, historical rounds stop
    // reproducing and this test says so loudly rather than a replay quietly
    // disagreeing months later.
    expect(schedule('round-1')).toEqual([
      { left: 'GME', right: 'GOOGL' },
      { left: 'NVDA', right: 'AAPL' },
      { left: 'SPY', right: 'AMZN' },
      { left: 'AMD', right: 'TSLA' },
      { left: 'META', right: 'MSFT' },
    ]);
  });
});

describe('cooldown', () => {
  it('collects the keys of recent pairings', () => {
    const previous: Pairing[] = [{ left: 'NVDA', right: 'AAPL' }];
    expect(cooldownSet([previous]).has(matchupKey('AAPL', 'NVDA'))).toBe(true);
  });

  it('looks back exactly two rounds and no further', () => {
    // §4.3: two rounds, twenty minutes. A third-oldest round is free again.
    const rounds: Pairing[][] = [
      [{ left: 'NVDA', right: 'AAPL' }],
      [{ left: 'MSFT', right: 'TSLA' }],
      [{ left: 'GME', right: 'META' }],
    ];
    const blocked = cooldownSet(rounds);
    expect(blocked.has(matchupKey('NVDA', 'AAPL'))).toBe(true);
    expect(blocked.has(matchupKey('MSFT', 'TSLA'))).toBe(true);
    expect(blocked.has(matchupKey('GME', 'META'))).toBe(false);
    expect(MATCHUP_COOLDOWN_ROUNDS).toBe(2);
  });

  it('never repeats a matchup from the previous two rounds', () => {
    const previous = schedule('round-1');
    const older = schedule('round-0');
    const next = schedule('round-2', [previous, older]);

    const blocked = cooldownSet([previous, older]);
    for (const pairing of next) {
      expect(blocked.has(matchupKey(pairing.left, pairing.right))).toBe(false);
    }
  });

  it('holds the cooldown across a long simulated run', () => {
    // Runs the scheduler the way production will: each round sees the two
    // before it. Any pairing that slipped through would surface here.
    const history: Pairing[][] = [];
    for (let round = 0; round < 300; round += 1) {
      const blocked = cooldownSet(history);
      const pairings = schedule(`sim-${String(round)}`, history);

      expect(pairings).toHaveLength(BATTLES_PER_ROUND);
      expect(new Set(flatten(pairings)).size).toBe(ACTIVE_TICKERS.length);
      for (const pairing of pairings) {
        expect(blocked.has(matchupKey(pairing.left, pairing.right))).toBe(false);
      }
      history.unshift([...pairings]);
    }
  });

  it('respects an adversarial history that blocks ten matchups', () => {
    // The densest legal forbidden set: two full perfect matchings, leaving each
    // ticker seven eligible partners. A schedule must still exist.
    const first: Pairing[] = [
      { left: 'NVDA', right: 'AAPL' },
      { left: 'MSFT', right: 'TSLA' },
      { left: 'GME', right: 'META' },
      { left: 'AMZN', right: 'GOOGL' },
      { left: 'AMD', right: 'SPY' },
    ];
    const second: Pairing[] = [
      { left: 'NVDA', right: 'MSFT' },
      { left: 'AAPL', right: 'GME' },
      { left: 'TSLA', right: 'AMZN' },
      { left: 'META', right: 'AMD' },
      { left: 'GOOGL', right: 'SPY' },
    ];
    const blocked = cooldownSet([first, second]);
    expect(blocked.size).toBe(10);

    for (let round = 0; round < 100; round += 1) {
      const pairings = schedule(`adversarial-${String(round)}`, [first, second]);
      expect(pairings).toHaveLength(BATTLES_PER_ROUND);
      for (const pairing of pairings) {
        expect(blocked.has(matchupKey(pairing.left, pairing.right))).toBe(false);
      }
    }
  });
});

describe('fairness', () => {
  it('gives every ticker a broad spread of opponents', () => {
    // Not a statistical proof, but it catches a scheduler that quietly favours
    // adjacency in the roster array - the failure a naive pairing would have.
    const opponents = new Map<ActiveTicker, Set<ActiveTicker>>();
    for (const ticker of ACTIVE_TICKERS) {
      opponents.set(ticker, new Set());
    }
    for (let round = 0; round < 400; round += 1) {
      for (const pairing of schedule(`fair-${String(round)}`)) {
        opponents.get(pairing.left)?.add(pairing.right);
        opponents.get(pairing.right)?.add(pairing.left);
      }
    }
    for (const ticker of ACTIVE_TICKERS) {
      // Nine possible opponents; every one should be reached over 400 rounds.
      expect(opponents.get(ticker)?.size).toBe(ACTIVE_TICKERS.length - 1);
    }
  });

  it('places each ticker on both sides over time', () => {
    // Sides are staging positions with no advantage (§38.3), but a scheduler
    // that always put the same ticker on the left would look rigged.
    const leftCount = new Map<ActiveTicker, number>();
    for (let round = 0; round < 400; round += 1) {
      for (const pairing of schedule(`sides-${String(round)}`)) {
        leftCount.set(pairing.left, (leftCount.get(pairing.left) ?? 0) + 1);
      }
    }
    for (const ticker of ACTIVE_TICKERS) {
      const count = leftCount.get(ticker) ?? 0;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(400);
    }
  });
});

describe('input validation', () => {
  it('rejects a roster of the wrong size', () => {
    expect(() =>
      scheduleRound({ baseSeedHex: SEED, roundId: 'r', roster: ['NVDA', 'AAPL'] }),
    ).toThrow(RangeError);
  });

  it('rejects a roster with duplicates', () => {
    const duplicated = [...ACTIVE_TICKERS.slice(0, 9), 'NVDA'] as ActiveTicker[];
    expect(() => scheduleRound({ baseSeedHex: SEED, roundId: 'r', roster: duplicated })).toThrow(
      RangeError,
    );
  });

  it('accepts a reserve substitution', () => {
    // §4.2: a reserve replaces an unhealthy active asset *before* the round.
    const substituted = [
      ...ACTIVE_TICKERS.filter((ticker) => ticker !== 'GME'),
      'COIN',
    ] as unknown as ActiveTicker[];
    const pairings = scheduleRound({ baseSeedHex: SEED, roundId: 'r', roster: substituted });
    expect(flatten(pairings)).toContain('COIN' as ActiveTicker);
    expect(flatten(pairings)).not.toContain('GME');
  });
});
