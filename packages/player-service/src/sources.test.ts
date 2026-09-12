import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  finalizeRound,
  lockRound,
  tickBattle,
  type EngineConfig,
  type RoundFinalization,
} from '@ponswars/battle-engine';
import {
  NO_CARD_SUPPORT,
  RATIO_SCALE,
  clockForRound,
  roundIdFor,
  type ConfidenceCalibration,
  type ConfidenceLookback,
  type SideInputs,
} from '@ponswars/battle-math';
import {
  ACTIVE_TICKERS,
  WP_AWARDS,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRecords, settledPicksIn } from './sources.js';

/**
 * A record read out of a round the engine actually played.
 *
 * Fixtures in `record.test.ts` say what a record means. This says the memory
 * source hands `playerRecord` the truth about a real finalization — the frozen
 * picks, the results, the voids and the awards — rather than a hand-built
 * approximation of them.
 */

const EPOCH = utcTimestamp(1_800_000_000_000);
const at = (offset: number): UtcTimestamp => utcTimestamp(EPOCH + offset);
const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 20n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

const CALIBRATION: ConfidenceCalibration = {
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: (RATIO_SCALE * 13n) / 10n, weak: (RATIO_SCALE * 7n) / 10n },
  ponsActivity: { high: 40n, medium: 15n },
  momentumStability: { stable: 2, mixed: 5 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

const FLAT: ConfidenceLookback = {
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 20n,
  subWindowReturns: [10n, 10n, 10n],
};

const side = (overrides: Partial<SideInputs> = {}): SideInputs => ({
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 0n,
  uniqueActiveWallets: 0n,
  cardSupport: NO_CARD_SUPPORT,
  ...overrides,
});

/**
 * One round: wallet 1 backs the left side of battle 0 with a card and wins;
 * wallet 1 is absent elsewhere; wallet 2 backs the right side of battle 1 and
 * loses; wallet 3 backs battle 4, which is never scored and voids.
 */
function playedRound(): RoundFinalization {
  const round = createRound({
    roundId: toRoundId(roundIdFor(0)),
    roundIndex: 0,
    clock: clockForRound(EPOCH, 0, EPOCH),
    baseSeedHex: `0x${'9f'.repeat(32)}`,
    recentRounds: [],
    confidence: {
      lookback: Object.fromEntries(ACTIVE_TICKERS.map((ticker) => [ticker, FLAT])),
      calibration: CALIBRATION,
    },
  });
  const battles = round.battles.map((battle) => battle.setup);
  const [first, second, , , fifth] = battles;
  if (first === undefined || second === undefined || fifth === undefined) {
    throw new Error('a round always has five battles');
  }

  let state = lockRound({ ...round, state: 'PICK_OPEN' }, at(60_000), [
    { wallet: wallet(1), battleId: first.battleId, backedTicker: first.left, cardDeployed: true },
    {
      wallet: wallet(2),
      battleId: second.battleId,
      backedTicker: second.right,
      cardDeployed: false,
    },
    { wallet: wallet(3), battleId: fifth.battleId, backedTicker: fifth.left, cardDeployed: true },
  ]);
  // Every battle but the last is scored with the left side clearly ahead.
  for (const battle of battles.slice(0, 4)) {
    state = tickBattle(
      state,
      battle.battleId,
      {
        at: at(120_000),
        left: side({ windowReturn: 2_000_000n }),
        right: side(),
        leftHealth: 'HEALTHY',
        rightHealth: 'HEALTHY',
      },
      CONFIG,
    );
  }
  return finalizeRound(state, at(600_000), `0x${'ab'.repeat(32)}`, CONFIG);
}

describe('records read from a played round', () => {
  const finalization = playedRound();
  const records = new MemoryPlayerRecords(() => [finalization]);

  it('credits a win with the award the engine made, card assist included', async () => {
    const record = await records.recordOf(wallet(1));

    expect(record.lifetime).toMatchObject({
      battles: 1,
      wins: 1,
      losses: 0,
      cardAssistedWins: 1,
      warPoints: WP_AWARDS.WIN + WP_AWARDS.CARD_ASSIST,
    });
    expect(record.history[0]).toMatchObject({ outcome: 'WIN', cardDeployed: true });
  });

  it('records a loss with no War Points', async () => {
    const record = await records.recordOf(wallet(2));

    expect(record.lifetime).toMatchObject({ battles: 1, wins: 0, losses: 1, warPoints: 0 });
    expect(record.history[0]?.outcome).toBe('LOSS');
  });

  it('shows a voided battle in the history without counting it as a loss', async () => {
    const record = await records.recordOf(wallet(3));

    expect(finalization.voided).toContain(record.history[0]?.battleId);
    expect(record.lifetime).toMatchObject({ battles: 0, losses: 0 });
    expect(record.history[0]?.outcome).toBe('VOID');
  });

  it('keeps every War Point in the window, since memory holds no snapshots', async () => {
    const record = await records.recordOf(wallet(1));

    expect(record.currentWindow.warPoints).toBe(record.lifetime.warPoints);
    expect(record.currentWindow.window).toBeNull();
  });

  it('finds nothing for a wallet that did not play', () => {
    expect(settledPicksIn([finalization], wallet(9))).toEqual([]);
  });
});
