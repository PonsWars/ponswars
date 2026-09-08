import { NO_CARD_SUPPORT, RATIO_SCALE, type SideInputs } from '@ponswars/battle-math';
import {
  ACTIVE_TICKERS,
  BATTLES_PER_ROUND,
  buildCanonicalClock,
  WP_AWARDS,
  type BattleId,
  type ConfidenceLabel,
  type RoundId,
  type UtcTimestamp,
  type WalletAddress,
  milliseconds,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { CURRENT_ENGINE_VERSIONS, type EngineConfig, type TickInput } from './engine.js';
import {
  createRound,
  finalizeRound,
  lockRound,
  sectorIds,
  tickBattle,
  type LockedPick,
  type RoundEngineState,
} from './round.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (T0 + offset) as UtcTimestamp;
const SEED = `0x${'9f'.repeat(32)}`;
const BLOCK = `0x${'ab'.repeat(32)}`;

const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 10n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

const evenConfidence = (): Record<string, ConfidenceLabel> =>
  Object.fromEntries(ACTIVE_TICKERS.map((ticker) => [ticker, 'EVEN']));

const side = (overrides: Partial<SideInputs> = {}): SideInputs => ({
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 0n,
  uniqueActiveWallets: 0n,
  cardSupport: NO_CARD_SUPPORT,
  ...overrides,
});

const tick = (offset: number, overrides: Partial<TickInput> = {}): TickInput => ({
  at: at(offset),
  left: side(),
  right: side(),
  leftHealth: 'HEALTHY',
  rightHealth: 'HEALTHY',
  ...overrides,
});

const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

const makeRound = (confidence = evenConfidence()): RoundEngineState =>
  createRound({
    roundId: 'round-0000000001' as RoundId,
    roundIndex: 1,
    clock: buildCanonicalClock(T0, T0),
    baseSeedHex: SEED,
    confidence,
  });

/** Drives every battle with one tick that makes the left side win. */
const driveLeftWins = (state: RoundEngineState): RoundEngineState => {
  let next = state;
  for (const battle of state.battles) {
    next = tickBattle(
      next,
      battle.setup.battleId,
      tick(120_000, { left: side({ windowReturn: 2_000_000n }) }),
      CONFIG,
    );
  }
  return next;
};

describe('createRound', () => {
  it('produces five battles covering every active ticker once', () => {
    const round = makeRound();
    expect(round.battles).toHaveLength(BATTLES_PER_ROUND);

    const used = round.battles.flatMap((b) => [b.setup.left, b.setup.right]);
    expect(new Set(used).size).toBe(ACTIVE_TICKERS.length);
    expect(round.state).toBe('PICK_OPEN');
  });

  it('is deterministic from seed and round id', () => {
    // §4.3: two nodes creating the same round must produce the same pairings,
    // and a third party must be able to check them.
    const a = makeRound().battles.map((b) => `${b.setup.left}:${b.setup.right}`);
    const b = makeRound().battles.map((b) => `${b.setup.left}:${b.setup.right}`);
    expect(b).toEqual(a);
  });

  it('refuses to start without confidence for every ticker', () => {
    // §11 derives the upset award from the winner's label; a missing entry
    // would silently downgrade an upset to an ordinary win.
    const partial = evenConfidence();
    delete partial['NVDA'];
    expect(() => makeRound(partial)).toThrow(RangeError);
  });

  it('names five neutral sectors', () => {
    expect(sectorIds()).toEqual(['sector-01', 'sector-02', 'sector-03', 'sector-04', 'sector-05']);
  });
});

describe('lockRound', () => {
  it('opens every battle and freezes the picks', () => {
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();

    const locked = lockRound(round, at(60_000), [
      {
        wallet: wallet(1),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.left,
        cardDeployed: false,
      },
    ]);

    expect(locked.state).toBe('BATTLE_LIVE');
    expect(locked.picks).toHaveLength(1);
    for (const battle of locked.battles) {
      expect(battle.state).toBe('LIVE');
    }
  });

  it('refuses to lock before the lock instant', () => {
    expect(() => lockRound(makeRound(), at(59_999), [])).toThrow(RangeError);
  });

  it('refuses two picks from one wallet', () => {
    // §49.8 makes this a database constraint. Enforcing it here too means a bug
    // upstream surfaces before it can double-award War Points.
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();
    const pick: LockedPick = {
      wallet: wallet(1),
      battleId: first!.setup.battleId,
      backedTicker: first!.setup.left,
      cardDeployed: false,
    };
    expect(() => lockRound(round, at(60_000), [pick, pick])).toThrow(RangeError);
  });

  it('refuses a pick for a battle outside the round', () => {
    expect(() =>
      lockRound(makeRound(), at(60_000), [
        {
          wallet: wallet(1),
          battleId: 'round-0000000099-b0' as BattleId,
          backedTicker: 'NVDA',
          cardDeployed: false,
        },
      ]),
    ).toThrow(RangeError);
  });

  it('refuses to lock twice', () => {
    const locked = lockRound(makeRound(), at(60_000), []);
    expect(() => lockRound(locked, at(60_000), [])).toThrow();
  });
});

describe('finalizeRound', () => {
  const runRound = (picks: readonly LockedPick[], confidence = evenConfidence()) => {
    const round = makeRound(confidence);
    const locked = lockRound(round, at(60_000), picks);
    const driven = driveLeftWins(locked);
    return finalizeRound(driven, at(600_000), BLOCK, CONFIG);
  };

  it('finalizes every battle and marks the round finalized', () => {
    const outcome = runRound([]);
    expect(outcome.results).toHaveLength(BATTLES_PER_ROUND);
    expect(outcome.voided).toHaveLength(0);
    expect(outcome.state.state).toBe('FINALIZED');
  });

  it('awards ten war points for a normal winning pick', () => {
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();

    const outcome = runRound([
      {
        wallet: wallet(1),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.left,
        cardDeployed: false,
      },
    ]);

    expect(outcome.awards).toEqual([
      { wallet: wallet(1), battleId: first!.setup.battleId, reason: 'WIN', points: WP_AWARDS.WIN },
    ]);
  });

  it('awards nothing for a losing pick', () => {
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();

    const outcome = runRound([
      {
        wallet: wallet(2),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.right,
        cardDeployed: false,
      },
    ]);
    expect(outcome.awards).toHaveLength(0);
  });

  it('emits the card assist as a separate ledger entry', () => {
    // §49.10 makes the ledger idempotent on (wallet, battle, reason). One
    // combined row would collapse two reasons and lose the ability to tell a
    // 12-point underdog win from a 10-point win with a card.
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();

    const outcome = runRound([
      {
        wallet: wallet(3),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.left,
        cardDeployed: true,
      },
    ]);

    expect(outcome.awards).toHaveLength(2);
    expect(outcome.awards.map((a) => a.reason).sort()).toEqual(['CARD_ASSIST', 'WIN']);
    expect(outcome.awards.reduce((sum, a) => sum + a.points, 0)).toBe(
      WP_AWARDS.WIN + WP_AWARDS.CARD_ASSIST,
    );
  });

  it('pays the upset award from the winner’s confidence', () => {
    // §11: 14 WP for a heavy-underdog win, from the label snapshotted at round
    // open rather than anything computed during the battle.
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();

    const confidence = evenConfidence();
    confidence[first!.setup.left] = 'HEAVY_UNDERDOG';

    const outcome = runRound(
      [
        {
          wallet: wallet(4),
          battleId: first!.setup.battleId,
          backedTicker: first!.setup.left,
          cardDeployed: false,
        },
      ],
      confidence,
    );

    const award = outcome.awards.find((a) => a.wallet === wallet(4));
    expect(award?.reason).toBe('HEAVY_UNDERDOG_WIN');
    expect(award?.points).toBe(WP_AWARDS.HEAVY_UNDERDOG_WIN);
  });

  it('records no award and no loss for a voided battle', () => {
    // §4.4 and §11: a VOID produces no winner, no War Points and no loss. The
    // picker is simply absent from the award list.
    const round = makeRound();
    const first = round.battles[0];
    expect(first).toBeDefined();

    let locked = lockRound(round, at(60_000), [
      {
        wallet: wallet(5),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.left,
        cardDeployed: true,
      },
    ]);
    locked = tickBattle(
      locked,
      first!.setup.battleId,
      tick(120_000, { leftHealth: 'STALE' }),
      CONFIG,
    );
    locked = driveLeftWins(locked);

    const outcome = finalizeRound(locked, at(600_000), BLOCK, CONFIG);

    expect(outcome.voided).toContain(first!.setup.battleId);
    expect(outcome.results).toHaveLength(BATTLES_PER_ROUND - 1);
    expect(outcome.awards.some((a) => a.wallet === wallet(5))).toBe(false);
    expect(outcome.state.state).toBe('FINALIZED');
  });

  it('stays in FINALIZING while waiting for late data', () => {
    // §72.5: a brief wait rather than fabricating a result. The round is not
    // finalized and no War Points are written yet.
    const locked = driveLeftWins(lockRound(makeRound(), at(60_000), []));
    const outcome = finalizeRound(locked, at(600_000), BLOCK, CONFIG, false);

    expect(outcome.state.state).toBe('FINALIZING');
    expect(outcome.results).toHaveLength(0);
    expect(outcome.awards).toHaveLength(0);
  });

  it('refuses to finalize a round that has not locked', () => {
    expect(() => finalizeRound(makeRound(), at(600_000), BLOCK, CONFIG)).toThrow();
  });

  it('awards each of many pickers independently', () => {
    const round = makeRound();
    const first = round.battles[0];
    const second = round.battles[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const outcome = runRound([
      {
        wallet: wallet(10),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.left,
        cardDeployed: false,
      },
      {
        wallet: wallet(11),
        battleId: first!.setup.battleId,
        backedTicker: first!.setup.right,
        cardDeployed: false,
      },
      {
        wallet: wallet(12),
        battleId: second!.setup.battleId,
        backedTicker: second!.setup.left,
        cardDeployed: true,
      },
    ]);

    const wallets = outcome.awards.map((a) => a.wallet);
    expect(wallets).toContain(wallet(10));
    expect(wallets).not.toContain(wallet(11));
    expect(outcome.awards.filter((a) => a.wallet === wallet(12))).toHaveLength(2);
  });

  it('reproduces the same results and awards from the same inputs', () => {
    // The whole round, end to end, is a pure function of its inputs.
    const picks: LockedPick[] = [];
    const first = makeRound().battles[0];
    expect(first).toBeDefined();
    picks.push({
      wallet: wallet(20),
      battleId: first!.setup.battleId,
      backedTicker: first!.setup.left,
      cardDeployed: true,
    });

    expect(runRound(picks).awards).toEqual(runRound(picks).awards);
    expect(runRound(picks).results).toEqual(runRound(picks).results);
  });
});
