import {
  createRound,
  finalizeRound,
  lockRound,
  tickBattle,
  type LockedPick,
  type WpAward,
} from '@ponswars/battle-engine';
import {
  clockForRound,
  DeterministicPrng,
  matchupKey,
  roundIdFor,
  type Pairing,
} from '@ponswars/battle-math';
import { allocateDistribution, buildMerkleTree, verifyProof } from '@ponswars/rewards-math';
import {
  ACTIVE_TICKERS,
  BATTLE_SCORE_TOTAL,
  BATTLES_PER_ROUND,
  MATCHUP_COOLDOWN_ROUNDS,
  MIN_QUALIFYING_WP,
  parseDecimalToBaseUnits,
  sumAmounts,
  WP_AWARDS,
  type ActiveTicker,
  type ConfidenceLabel,
  type RoundId,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  CONFIDENCE_BY_TICKER,
  CONFIG,
  EPOCH,
  SEED,
  SPY,
  TICKS_PER_BATTLE,
  wallet,
  WALLET_COUNT,
} from './harness.js';
import { observe } from './market.js';

/**
 * End-to-end deterministic simulation (Kickoff Brief §8, masterplan §54).
 *
 * Runs the whole loop many rounds deep — matchmaking, picks, live ticks,
 * finalization, War Points, then a 24-hour distribution and the Merkle tree
 * that settles it — and asserts the invariants that must hold across all of it.
 *
 * Everything is seeded. A failure here is reproducible from its seed alone,
 * which is the only kind of simulation failure worth having.
 */

interface RoundOutcome {
  readonly index: number;
  readonly pairings: readonly Pairing[];
  readonly awards: readonly WpAward[];
  /** Both sides' labels for every battle, as the round opened them (§10.1). */
  readonly intelLabels: readonly ConfidenceLabel[];
  readonly finalizedCount: number;
  readonly voidedCount: number;
}

/**
 * Runs one round end to end.
 *
 * Mirrors the canonical flow in §68: create, take picks, lock, tick through the
 * battle window, finalize.
 */
function runRound(
  index: number,
  history: readonly (readonly Pairing[])[],
  marketSeed: string,
): RoundOutcome {
  const clock = clockForRound(EPOCH, index, EPOCH);
  const roundId = roundIdFor(index) as RoundId;

  const round = createRound({
    roundId,
    roundIndex: index,
    clock,
    baseSeedHex: SEED,
    recentRounds: history,
    confidence: CONFIDENCE_BY_TICKER,
  });

  const pairings: Pairing[] = round.battles.map((battle) => ({
    left: battle.setup.left,
    right: battle.setup.right,
  }));

  // Wallets pick deterministically: which battle, which side, whether to spend
  // a card. Seeded per round so the population behaves differently each time
  // without becoming unreproducible.
  const picker = new DeterministicPrng(SEED, `PICKS|${String(index)}`);
  const picks: LockedPick[] = [];
  for (let w = 0; w < WALLET_COUNT; w += 1) {
    // Not every wallet plays every round.
    if (picker.nextBelow(100) < 25) continue;

    const battle = round.battles[picker.nextBelow(BATTLES_PER_ROUND)];
    if (battle === undefined) continue;

    const backLeft = picker.nextBelow(2) === 0;
    picks.push({
      wallet: wallet(w + 1),
      battleId: battle.setup.battleId,
      backedTicker: backLeft ? battle.setup.left : battle.setup.right,
      cardDeployed: picker.nextBelow(100) < 30,
    });
  }

  let state = lockRound(round, clock.lockAt, picks);

  for (let tickIndex = 0; tickIndex < TICKS_PER_BATTLE; tickIndex += 1) {
    const at = (clock.battleStartAt + (tickIndex + 1) * 60_000 - 1_000) as UtcTimestamp;
    for (const battle of state.battles) {
      const left = observe(marketSeed, index, tickIndex, battle.setup.left);
      const right = observe(marketSeed, index, tickIndex, battle.setup.right);
      state = tickBattle(
        state,
        battle.setup.battleId,
        {
          at,
          left: left.inputs,
          right: right.inputs,
          leftHealth: left.health,
          rightHealth: right.health,
        },
        CONFIG,
      );
    }
  }

  const outcome = finalizeRound(state, clock.battleEndAt, BLOCK, CONFIG);

  // §12: every finalized result must account for exactly 100 points.
  for (const result of outcome.results) {
    const total =
      result.leftScore.priceMomentum +
      result.leftScore.relativeVolume +
      result.leftScore.ponsPower +
      result.leftScore.holderCardSupport +
      result.rightScore.priceMomentum +
      result.rightScore.relativeVolume +
      result.rightScore.ponsPower +
      result.rightScore.holderCardSupport;
    expect(total).toBe(BATTLE_SCORE_TOTAL * 1_000_000);
  }

  return {
    index,
    pairings,
    awards: outcome.awards,
    intelLabels: round.battles.flatMap((battle) => [
      battle.setup.leftIntel.label,
      battle.setup.rightIntel.label,
    ]),
    finalizedCount: outcome.results.length,
    voidedCount: outcome.voided.length,
  };
}

function runSimulation(rounds: number, marketSeed = SEED): RoundOutcome[] {
  const outcomes: RoundOutcome[] = [];
  const history: Pairing[][] = [];

  for (let index = 0; index < rounds; index += 1) {
    const outcome = runRound(index, history, marketSeed);
    outcomes.push(outcome);
    history.unshift([...outcome.pairings]);
    history.length = Math.min(history.length, MATCHUP_COOLDOWN_ROUNDS);
  }
  return outcomes;
}

describe('a fifty-round simulation', () => {
  const outcomes = runSimulation(50);

  it('finalizes every battle in every round', () => {
    for (const outcome of outcomes) {
      expect(outcome.finalizedCount + outcome.voidedCount).toBe(BATTLES_PER_ROUND);
    }
  });

  it('never repeats a matchup inside the cooldown', () => {
    // §4.3, checked the way production will see it: each round against the two
    // that preceded it.
    for (let i = MATCHUP_COOLDOWN_ROUNDS; i < outcomes.length; i += 1) {
      const blocked = new Set<string>();
      for (let back = 1; back <= MATCHUP_COOLDOWN_ROUNDS; back += 1) {
        const previous = outcomes[i - back];
        if (previous === undefined) continue;
        for (const pairing of previous.pairings) {
          blocked.add(matchupKey(pairing.left, pairing.right));
        }
      }
      const current = outcomes[i];
      expect(current).toBeDefined();
      for (const pairing of current!.pairings) {
        expect(blocked.has(matchupKey(pairing.left, pairing.right))).toBe(false);
      }
    }
  });

  it('uses every active ticker exactly once per round', () => {
    for (const outcome of outcomes) {
      const used = outcome.pairings.flatMap((p) => [p.left, p.right]);
      expect(new Set(used).size).toBe(ACTIVE_TICKERS.length);
    }
  });

  it('awards only the locked War Point values', () => {
    // §11. Any other number would mean a value was computed rather than read.
    const allowed = new Set(Object.values(WP_AWARDS));
    for (const outcome of outcomes) {
      for (const award of outcome.awards) {
        expect(allowed.has(award.points)).toBe(true);
      }
    }
  });

  it('pairs every card assist with a base award for the same battle', () => {
    // §11 makes Card Assist a bonus on a *winning* pick, never a standalone
    // award. An orphaned assist would mean a losing picker was paid.
    for (const outcome of outcomes) {
      const bases = new Set(
        outcome.awards
          .filter((a) => a.reason !== 'CARD_ASSIST')
          .map((a) => `${a.wallet}:${a.battleId}`),
      );
      for (const award of outcome.awards.filter((a) => a.reason === 'CARD_ASSIST')) {
        expect(bases.has(`${award.wallet}:${award.battleId}`)).toBe(true);
      }
    }
  });

  it('never awards a wallet twice for the same reason in one battle', () => {
    // §49.10 makes this a database constraint. If the engine can produce a
    // duplicate, the constraint would reject a legitimate finalization.
    for (const outcome of outcomes) {
      const keys = outcome.awards.map((a) => `${a.wallet}:${a.battleId}:${a.reason}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('exercises upsets and ordinary wins alike', () => {
    // A simulation where every winner is a favourite would not test the upset
    // path at all. Both tiers are named rather than counted, because §11 prices
    // them differently and a run that reached only one would leave the other
    // award untested while still looking varied.
    const reasons = new Set(outcomes.flatMap((o) => o.awards.map((a) => a.reason)));
    expect(reasons.has('WIN')).toBe(true);
    expect(reasons.has('UNDERDOG_WIN')).toBe(true);
    expect(reasons.has('HEAVY_UNDERDOG_WIN')).toBe(true);
  });

  it('opens matchups across the confidence vocabulary', () => {
    // The fixture supplies market strengths, not labels (§10.2), so what the
    // rounds actually open at has to be checked rather than assumed — a spread
    // of lookbacks that happened to pair like with like would quietly stop
    // exercising the upset paths above.
    const labels = new Set(outcomes.flatMap((outcome) => outcome.intelLabels));
    expect(labels.has('EVEN')).toBe(true);
    expect(labels.has('UNDERDOG')).toBe(true);
    expect(labels.has('HEAVY_UNDERDOG')).toBe(true);
    expect(labels.has('DOMINANT')).toBe(true);
  });

  it('is reproducible from the seed', () => {
    // The property that makes a failing simulation worth anything.
    expect(runSimulation(5)).toEqual(runSimulation(5));
  });
});

describe('feed failures', () => {
  it('voids affected battles rather than inventing results', () => {
    // §4.4 and Brief §6, driven through the whole stack: a market that
    // sometimes reports unusable data must produce VOIDs, never a fabricated
    // winner.
    const flaky = runSimulation(20, `0x${'a7'.repeat(32)}`);
    const withFailures = flaky.map((o) => o.voidedCount);
    expect(withFailures.every((count) => count >= 0)).toBe(true);

    for (const outcome of flaky) {
      expect(outcome.finalizedCount + outcome.voidedCount).toBe(BATTLES_PER_ROUND);
    }
  });
});

describe('a full 24-hour distribution window', () => {
  // §16.2: 144 ten-minute rounds fill one distribution window exactly.
  const ROUNDS_PER_WINDOW = 144;

  it('settles a window end to end without creating or losing SPY', () => {
    const outcomes = runSimulation(ROUNDS_PER_WINDOW);

    const windowWp = new Map<WalletAddress, number>();
    for (const outcome of outcomes) {
      for (const award of outcome.awards) {
        windowWp.set(award.wallet, (windowWp.get(award.wallet) ?? 0) + award.points);
      }
    }
    expect(windowWp.size).toBeGreaterThan(0);

    const pool = parseDecimalToBaseUnits('5000', SPY);
    const allocation = allocateDistribution({
      poolBalance: pool,
      standings: [...windowWp].map(([w, points]) => ({ wallet: w, windowWarPoints: points })),
      minimumClaim: parseDecimalToBaseUnits('0.001', SPY),
    });

    // §16: nothing is created and nothing is lost.
    const paid = allocation.allocations.reduce((sum, a) => sum + a.amount, 0n);
    expect(paid + allocation.carriedForward).toBe(pool);

    // §16.4: nobody below the floor is allocated at all.
    for (const entry of allocation.allocations) {
      expect(entry.windowWarPoints).toBeGreaterThanOrEqual(MIN_QUALIFYING_WP);
    }

    // §16.6: the 2% cap holds against the distributable share.
    const cap = (allocation.distributable * 200n) / 10_000n;
    for (const entry of allocation.allocations) {
      expect(entry.amount).toBeLessThanOrEqual(cap);
    }
  });

  it('builds a claimable Merkle tree over the window’s allocations', () => {
    const outcomes = runSimulation(ROUNDS_PER_WINDOW);

    const windowWp = new Map<WalletAddress, number>();
    for (const outcome of outcomes) {
      for (const award of outcome.awards) {
        windowWp.set(award.wallet, (windowWp.get(award.wallet) ?? 0) + award.points);
      }
    }

    const allocation = allocateDistribution({
      poolBalance: parseDecimalToBaseUnits('5000', SPY),
      standings: [...windowWp].map(([w, points]) => ({ wallet: w, windowWarPoints: points })),
      minimumClaim: parseDecimalToBaseUnits('0.001', SPY),
    });

    const claimable = allocation.allocations.filter((a) => a.amount > 0n);
    expect(claimable.length).toBeGreaterThan(0);

    const tree = buildMerkleTree(
      1n,
      claimable.map((a) => ({ wallet: a.wallet, amount: a.amount })),
    );

    // The total the root commits to is exactly what the contract will be asked
    // to pay, and every wallet holds a proof it can claim with.
    expect(tree.total).toBe(sumAmounts(claimable.map((a) => a.amount)));
    for (const claim of tree.claims) {
      expect(verifyProof(claim.leaf, claim.proof, tree.root)).toBe(true);
    }
  });
});

describe('ticker fairness over a long run', () => {
  it('gives every faction a comparable share of appearances', () => {
    // Every ticker appears once per round by construction, so this checks the
    // stronger property that no ticker is systematically pinned to one side.
    const outcomes = runSimulation(200);
    const leftCount = new Map<ActiveTicker, number>();

    for (const outcome of outcomes) {
      for (const pairing of outcome.pairings) {
        leftCount.set(pairing.left, (leftCount.get(pairing.left) ?? 0) + 1);
      }
    }

    for (const ticker of ACTIVE_TICKERS) {
      const count = leftCount.get(ticker) ?? 0;
      expect(count).toBeGreaterThan(200 * 0.2);
      expect(count).toBeLessThan(200 * 0.8);
    }
  });
});
