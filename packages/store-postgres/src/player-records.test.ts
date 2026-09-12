import { PGlite } from '@electric-sql/pglite';
import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  finalizeRound,
  lockRound,
  tickBattle,
  type EngineConfig,
  type RoundEngineState,
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
import { MemoryPlayerRecords } from '@ponswars/player-service';
import {
  ACTIVE_TICKERS,
  clientRequestId,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPickStore } from './pick-store.js';
import { PostgresPlayerRecords } from './player-records.js';
import { PostgresRoundStore } from './round-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * Records read back from PostgreSQL, held to the memory source.
 *
 * A round is played the way a deployment plays one — picks through the pick
 * store, frozen by it, scored by the engine, finalized into the round store —
 * and then the record each wallet gets from the database is compared with the
 * record the memory source derives from the same finalization. Two sources, one
 * derivation: if they ever disagree, one of them is reading the ledgers wrong.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

// A real PostgreSQL, compiled to WebAssembly, with every migration applied
// before each test: two to three seconds apiece on a quiet machine, and past
// vitest's five-second default on a busy one. The limit is raised for this file
// rather than for the whole suite, so a pure test that hangs still fails fast.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
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

const NEUTRAL: ConfidenceLookback = {
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 20n,
  subWindowReturns: [10n, 10n, 10n],
};

/** Enough of an edge that one side is labelled favourite and the other underdog. */
const STRONGEST: ConfidenceLookback = {
  windowReturn: RATIO_SCALE,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE * 2n,
  qualifiedPonsActivity: 100n,
  subWindowReturns: [10n, 20n, 30n],
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

function database(pg: PGlite): SqlDatabase {
  const query = async (text: string, params?: readonly unknown[]): Promise<{ rows: SqlRow[] }> => {
    const result = await pg.query<SqlRow>(text, params === undefined ? [] : [...params]);
    return { rows: result.rows };
  };
  return {
    query,
    transaction: async (work) => {
      await pg.exec('BEGIN');
      try {
        const value = await work({ query });
        await pg.exec('COMMIT');
        return value;
      } catch (error: unknown) {
        await pg.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

let pg: PGlite;
let db: SqlDatabase;

beforeEach(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  db = database(pg);
});

afterEach(async () => {
  await pg.close();
});

/**
 * Plays one round through the stores.
 *
 * Every ticker is neutral except NVDA, so NVDA's battle has a favourite and an
 * underdog; the ticks then make the *left* side of every scored battle win, and
 * the last battle is never scored and voids. The picks back both sides, with
 * and without cards, so wins, losses, upsets, card assists and a void all
 * appear.
 */
async function playRound(): Promise<{ finalization: RoundFinalization; round: RoundEngineState }> {
  const lookback: Record<string, ConfidenceLookback> = Object.fromEntries(
    ACTIVE_TICKERS.map((ticker) => [ticker, NEUTRAL]),
  );
  lookback['NVDA'] = STRONGEST;

  const opened: RoundEngineState = {
    ...createRound({
      roundId: toRoundId(roundIdFor(0)),
      roundIndex: 0,
      clock: clockForRound(EPOCH, 0, EPOCH),
      baseSeedHex: `0x${'9f'.repeat(32)}`,
      recentRounds: [],
      confidence: { lookback, calibration: CALIBRATION },
    }),
    state: 'PICK_OPEN',
  };
  const rounds = new PostgresRoundStore(db);
  const picks = new PostgresPickStore(db);
  await rounds.saveState(opened);

  const battles = opened.battles.map((battle) => battle.setup);
  let n = 0;
  for (const [index, battle] of battles.entries()) {
    for (const choice of ['left', 'right'] as const) {
      n += 1;
      await picks.submit({
        wallet: wallet(n),
        roundId: opened.roundId,
        battleId: battle.battleId,
        backedTicker: battle[choice],
        cardDecision: (index + n) % 2 === 0 ? 'USE' : 'SAVE',
        receivedAt: at(1_000 + n),
        clientRequestId: clientRequestId(`req-${String(n)}`),
      });
    }
  }

  let state = lockRound(opened, at(60_000), await picks.lockedPicks(opened.roundId));
  await rounds.saveState(state);
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
  const finalization = finalizeRound(state, at(600_000), `0x${'ab'.repeat(32)}`, CONFIG);
  await rounds.saveFinalization(finalization);
  return { finalization, round: opened };
}

describe('a record read from the database', () => {
  it('is the record the memory source derives from the same round, for every wallet', async () => {
    const { finalization } = await playRound();
    const stored = new PostgresPlayerRecords(db);
    const remembered = new MemoryPlayerRecords(() => [finalization]);

    for (let n = 1; n <= 10; n += 1) {
      expect(await stored.recordOf(wallet(n)), `wallet ${String(n)}`).toEqual(
        await remembered.recordOf(wallet(n)),
      );
    }
  });

  it('covers every kind of outcome, so the comparison above means something', async () => {
    await playRound();
    const stored = new PostgresPlayerRecords(db);

    const records = await Promise.all(
      Array.from({ length: 10 }, (_, index) => stored.recordOf(wallet(index + 1))),
    );
    const outcomes = new Set(
      records.flatMap((record) => record.history.map((entry) => entry.outcome)),
    );

    expect(outcomes).toContain('LOSS');
    expect(outcomes).toContain('VOID');
    expect([...outcomes].some((outcome) => outcome !== 'LOSS' && outcome !== 'VOID')).toBe(true);
    expect(records.some((record) => record.lifetime.cardAssistedWins > 0)).toBe(true);
  });

  it('is empty for a wallet that never played', async () => {
    await playRound();

    const record = await new PostgresPlayerRecords(db).recordOf(wallet(99));

    expect(record.lifetime.battles).toBe(0);
    expect(record.history).toEqual([]);
    expect(record.currentWindow.warPoints).toBe(0);
  });

  it('ignores a pick that was never locked', async () => {
    // A pick in a round still open has no outcome and no place in a record.
    const opened: RoundEngineState = {
      ...createRound({
        roundId: toRoundId(roundIdFor(3)),
        roundIndex: 3,
        clock: clockForRound(EPOCH, 3, EPOCH),
        baseSeedHex: `0x${'9f'.repeat(32)}`,
        recentRounds: [],
        confidence: {
          lookback: Object.fromEntries(ACTIVE_TICKERS.map((ticker) => [ticker, NEUTRAL])),
          calibration: CALIBRATION,
        },
      }),
      state: 'PICK_OPEN',
    };
    await new PostgresRoundStore(db).saveState(opened);
    const battle = opened.battles[0]?.setup;
    if (battle === undefined) {
      throw new Error('a round always has five battles');
    }
    await new PostgresPickStore(db).submit({
      wallet: wallet(1),
      roundId: opened.roundId,
      battleId: battle.battleId,
      backedTicker: battle.left,
      cardDecision: 'SAVE',
      receivedAt: at(1_000),
      clientRequestId: clientRequestId('open'),
    });

    expect((await new PostgresPlayerRecords(db).recordOf(wallet(1))).history).toEqual([]);
  });
});

describe('the current window', () => {
  it('counts only War Points no snapshot has claimed (§16.2)', async () => {
    await playRound();
    const stored = new PostgresPlayerRecords(db);
    const winner = (
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => stored.recordOf(wallet(index + 1))),
      )
    ).find((record) => record.lifetime.warPoints > 0);
    if (winner === undefined) {
      throw new Error('somebody won something');
    }

    await db.query(
      `INSERT INTO distribution_windows (distribution_id, state, window_start, window_end)
       VALUES ('dist-1', 'SNAPSHOT', $1, $2)`,
      [new Date(EPOCH - 86_400_000).toISOString(), new Date(EPOCH).toISOString()],
    );
    await db.query(`UPDATE wp_ledger SET distribution_id = 'dist-1' WHERE wallet = $1`, [
      winner.wallet,
    ]);

    const after = await stored.recordOf(winner.wallet);
    expect(after.currentWindow.warPoints).toBe(0);
    expect(after.lifetime.warPoints).toBe(winner.lifetime.warPoints);
  });

  it('names the open window and when it closes', async () => {
    const closesAt = EPOCH + 86_400_000;
    await db.query(
      `INSERT INTO distribution_windows (distribution_id, state, window_start, window_end)
       VALUES ('dist-2', 'OPEN', $1, $2)`,
      [new Date(EPOCH).toISOString(), new Date(closesAt).toISOString()],
    );

    const record = await new PostgresPlayerRecords(db).recordOf(wallet(1));

    expect(record.currentWindow.window).toEqual({
      distributionId: 'dist-2',
      closesAt: utcTimestamp(closesAt),
    });
  });
});
