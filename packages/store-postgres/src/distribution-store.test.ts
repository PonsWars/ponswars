import { PGlite } from '@electric-sql/pglite';
import { createRound, type RoundEngineState } from '@ponswars/battle-engine';
import {
  RATIO_SCALE,
  clockForRound,
  roundIdFor,
  type ConfidenceCalibration,
  type ConfidenceLookback,
} from '@ponswars/battle-math';
import { allocateDistribution } from '@ponswars/rewards-math';
import {
  ACTIVE_TICKERS,
  baseUnits,
  rewardWeight,
  roundId as toRoundId,
  utcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributionError, PostgresDistributionStore } from './distribution-store.js';
import { PostgresRoundStore } from './round-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * Opening and snapshotting distribution windows against real PostgreSQL.
 *
 * The table's own constraints are in play — a window of exactly 24 hours, a
 * distributable amount of exactly 80% — so a store that computed either wrongly
 * is refused by the database, not merely by these assertions.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

// A real PostgreSQL, compiled to WebAssembly, with every migration applied
// before each test: two to three seconds apiece on a quiet machine, and past
// vitest's five-second default on a busy one. The limit is raised for this file
// rather than for the whole suite, so a pure test that hangs still fails fast.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const HOUR = 3_600_000;
const EPOCH = utcTimestamp(1_800_000_000_000);
const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

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
let store: PostgresDistributionStore;
let round: RoundEngineState;

beforeEach(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  db = database(pg);
  store = new PostgresDistributionStore(db);
  // War Points reference a round and its battles, so there is one to credit.
  round = createRound({
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
  await new PostgresRoundStore(db).saveState(round);
});

afterEach(async () => {
  await pg.close();
});

/** Credits War Points the way finalization does, one award per battle and reason. */
async function award(who: WalletAddress, battle: number, points: number): Promise<void> {
  const battleId = round.battles[battle]?.setup.battleId;
  if (battleId === undefined) {
    throw new Error('a round always has five battles');
  }
  await db.query(
    `INSERT INTO wallet_profiles (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING`,
    [who],
  );
  await db.query(
    `INSERT INTO wp_ledger (wallet, round_id, battle_id, reason, points) VALUES ($1, $2, $3, 'WIN', $4)`,
    [who, round.roundId, battleId, points],
  );
}

/** A window whose 24 hours ended an hour ago. */
async function closedWindow(distributionId: bigint): Promise<void> {
  await store.openWindow({ distributionId, windowStart: utcTimestamp(Date.now() - 25 * HOUR) });
}

describe('opening a window', () => {
  it('opens exactly twenty-four hours (§16.2)', async () => {
    const start = utcTimestamp(Date.now());

    const { windowEnd } = await store.openWindow({ distributionId: 42n, windowStart: start });

    expect(windowEnd).toBe(start + 24 * HOUR);
    const { rows } = await db.query(
      `SELECT state, extract(epoch FROM window_end - window_start)::int AS seconds
         FROM distribution_windows WHERE distribution_id = '42'`,
    );
    expect(rows[0]).toEqual({ state: 'OPEN', seconds: 86_400 });
  });

  it('refuses a second window while one is open', async () => {
    await store.openWindow({ distributionId: 1n, windowStart: utcTimestamp(Date.now()) });

    await expect(
      store.openWindow({ distributionId: 2n, windowStart: utcTimestamp(Date.now() + 24 * HOUR) }),
    ).rejects.toThrow(/still open/);
  });

  it('never reuses an identifier, because the claim contract commits to it', async () => {
    await closedWindow(7n);
    await store.snapshot({ distributionId: 7n, poolBalance: baseUnits(0n) });

    await expect(
      store.openWindow({ distributionId: 7n, windowStart: utcTimestamp(Date.now()) }),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses an identifier that is not a non-negative integer', async () => {
    await expect(
      store.openWindow({ distributionId: -1n, windowStart: utcTimestamp(Date.now()) }),
    ).rejects.toBeInstanceOf(DistributionError);
  });
});

describe('taking a snapshot', () => {
  it('refuses a window whose 24 hours are not over', async () => {
    await store.openWindow({ distributionId: 3n, windowStart: utcTimestamp(Date.now()) });

    await expect(
      store.snapshot({ distributionId: 3n, poolBalance: baseUnits(1_000n) }),
    ).rejects.toThrow(/has not closed yet/);
  });

  it('refuses a window that does not exist, and a negative pool', async () => {
    await expect(
      store.snapshot({ distributionId: 9n, poolBalance: baseUnits(1n) }),
    ).rejects.toThrow(/no distribution 9/);
    await closedWindow(4n);
    await expect(
      store.snapshot({ distributionId: 4n, poolBalance: baseUnits(-1n) }),
    ).rejects.toBeInstanceOf(DistributionError);
  });

  it('claims every unclaimed War Point, by wallet, in one order', async () => {
    await award(wallet(3), 0, 10);
    await award(wallet(1), 1, 12);
    await award(wallet(1), 2, 14);
    await award(wallet(2), 3, 50);
    await closedWindow(5n);

    const snapshot = await store.snapshot({
      distributionId: 5n,
      poolBalance: baseUnits(12_400_000n),
    });

    expect(snapshot).toEqual({
      distributionId: 5n,
      poolBalance: baseUnits(12_400_000n),
      standings: [
        { wallet: wallet(1), windowWarPoints: 26 },
        { wallet: wallet(2), windowWarPoints: 50 },
        { wallet: wallet(3), windowWarPoints: 10 },
      ],
    });
    const unclaimed = await db.query(
      'SELECT count(*)::int AS rows FROM wp_ledger WHERE distribution_id IS NULL',
    );
    expect(unclaimed.rows[0]?.['rows']).toBe(0);
  });

  it('fixes the pool, the 80% split, and who qualified (§16.3, §16.4, §16.5)', async () => {
    await award(wallet(1), 0, 49);
    await award(wallet(2), 1, 64);
    await award(wallet(3), 2, 100);
    await closedWindow(6n);

    await store.snapshot({ distributionId: 6n, poolBalance: baseUnits(1_000_001n) });

    const { rows } = await db.query(
      `SELECT state, pool_snapshot::text AS pool, distributable::text AS distributable,
              qualified_wallets, total_qualified_weight::text AS weight
         FROM distribution_windows WHERE distribution_id = '6'`,
    );
    expect(rows[0]).toEqual({
      state: 'SNAPSHOT',
      pool: '1000001',
      distributable: '800000',
      qualified_wallets: 2,
      weight: (rewardWeight(64) + rewardWeight(100)).toString(),
    });
  });

  it('is taken once', async () => {
    await closedWindow(8n);
    await store.snapshot({ distributionId: 8n, poolBalance: baseUnits(5n) });

    await expect(
      store.snapshot({ distributionId: 8n, poolBalance: baseUnits(5n) }),
    ).rejects.toThrow(/SNAPSHOT, not OPEN/);
  });

  it('leaves War Points earned after it for the next window', async () => {
    await award(wallet(1), 0, 20);
    await closedWindow(10n);
    await store.snapshot({ distributionId: 10n, poolBalance: baseUnits(5n) });

    await award(wallet(1), 1, 30);

    const { rows } = await db.query(
      `SELECT distribution_id, points FROM wp_ledger WHERE wallet = $1 ORDER BY points`,
      [wallet(1)],
    );
    expect(rows).toEqual([
      { distribution_id: '10', points: 20 },
      { distribution_id: null, points: 30 },
    ]);
  });

  it('opens the way for the next window', async () => {
    await closedWindow(11n);
    await store.snapshot({ distributionId: 11n, poolBalance: baseUnits(5n) });

    await expect(
      store.openWindow({ distributionId: 12n, windowStart: utcTimestamp(Date.now()) }),
    ).resolves.toBeDefined();
  });

  it('produces what the allocation is calculated from, and it settles without losing SPY', async () => {
    for (let n = 1; n <= 12; n += 1) {
      await award(wallet(n), n % 5, 30 + n * 7);
    }
    await closedWindow(13n);

    const snapshot = await store.snapshot({
      distributionId: 13n,
      poolBalance: baseUnits(9_876_543n),
    });
    const result = allocateDistribution({
      poolBalance: snapshot.poolBalance,
      minimumClaim: baseUnits(1_000n),
      standings: snapshot.standings,
    });

    expect(result.totalAllocated + result.carriedForward).toBe(snapshot.poolBalance);
  });
});
