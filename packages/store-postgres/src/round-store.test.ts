import { PGlite } from '@electric-sql/pglite';
import {
  createRound,
  finalizeRound,
  lockRound,
  tickBattle,
  CURRENT_ENGINE_VERSIONS,
  type EngineConfig,
  type RoundEngineState,
  type TickInput,
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
import { PostgresRoundStore, readFinalizedResult } from './round-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * The adapter against real PostgreSQL.
 *
 * `PGlite` is PostgreSQL compiled to WebAssembly, so the migrations below are
 * applied by the actual server and every constraint in them is enforced. That
 * matters more here than anywhere: `battle_results` requires the four
 * components to sum to a hundred points and each weight to its §12 share, so a
 * column mapped to the wrong parameter is refused by the database. A fake
 * client would have accepted it.
 *
 * It also means these run everywhere. The alternative — `pnpm run db:up` under
 * Docker — is a test nobody runs on a laptop without the daemon, and a test
 * that does not run is not a test.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

// A real PostgreSQL, compiled to WebAssembly, with every migration applied
// before each test: two to three seconds apiece on a quiet machine, and past
// vitest's five-second default on a busy one. The limit is raised for this file
// rather than for the whole suite, so a pure test that hangs still fails fast.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const EPOCH = utcTimestamp(1_800_000_000_000);
const SEED = `0x${'9f'.repeat(32)}`;
const BLOCK = `0x${'ab'.repeat(32)}`;

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

const STRONGEST: ConfidenceLookback = {
  windowReturn: RATIO_SCALE,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE * 2n,
  qualifiedPonsActivity: 100n,
  subWindowReturns: [10n, 20n, 30n],
};

const at = (offset: number): UtcTimestamp => (EPOCH + offset) as UtcTimestamp;
const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

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

/** A round whose first battle has a clear favourite, so a label is not all EVEN. */
function openRound(): RoundEngineState {
  const lookback: Record<string, ConfidenceLookback> = Object.fromEntries(
    ACTIVE_TICKERS.map((ticker) => [ticker, NEUTRAL]),
  );
  lookback['NVDA'] = STRONGEST;

  return createRound({
    roundId: toRoundId(roundIdFor(0)),
    roundIndex: 0,
    clock: clockForRound(EPOCH, 0, EPOCH),
    baseSeedHex: SEED,
    recentRounds: [],
    confidence: { lookback, calibration: CALIBRATION },
  });
}

/** Drives every battle to a decided result and finalizes the round. */
function finishedRound(state: RoundEngineState, walletCount: number) {
  const picks = Array.from({ length: walletCount }, (_, index) => {
    const battle = state.battles[index % state.battles.length];
    if (battle === undefined) {
      throw new Error('a round always has five battles');
    }
    return {
      wallet: wallet(index + 1),
      battleId: battle.setup.battleId,
      backedTicker: battle.setup.left,
      cardDeployed: index % 3 === 0,
    };
  });

  let next = lockRound(state, at(60_000), picks);
  for (const battle of next.battles) {
    next = tickBattle(
      next,
      battle.setup.battleId,
      tick(120_000, { left: side({ windowReturn: 2_000_000n }) }),
      CONFIG,
    );
  }
  return finalizeRound(next, at(600_000), BLOCK, CONFIG);
}

/** A `PGlite` instance presented through the adapter's own interface. */
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
let store: PostgresRoundStore;

beforeEach(async () => {
  pg = new PGlite();
  // The real migrations, in order, applied by the real server. A hand-written
  // schema for tests would be a second definition that drifts from the one
  // production runs.
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  store = new PostgresRoundStore(database(pg));
});

afterEach(async () => {
  await pg.close();
});

describe('saving a round', () => {
  it('writes the round and its five battles', async () => {
    const round = openRound();
    await store.saveState(round);

    const rounds = await pg.query<{ state: string; matchmaking_seed: string }>(
      'SELECT state, matchmaking_seed FROM rounds',
    );
    const battles = await pg.query<{ count: string }>('SELECT count(*) AS count FROM battles');

    expect(rounds.rows[0]?.state).toBe('PICK_OPEN');
    expect(rounds.rows[0]?.matchmaking_seed).toBe(SEED);
    expect(Number(battles.rows[0]?.count)).toBe(5);
  });

  it('stores the whole confidence snapshot, not just the label', async () => {
    // §10.2 gives the client four qualitative sub-signals beside the label, and
    // the schema had columns for only the label — so a round read back would
    // have lost the intel panel. Migration 0007 exists for this.
    const round = openRound();
    await store.saveState(round);

    const rows = await pg.query<{
      left_confidence: string;
      left_price_trend: string;
      left_volume_pulse: string;
      left_pons_activity: string;
      left_momentum_stability: string;
    }>(
      `SELECT left_confidence, left_price_trend, left_volume_pulse,
              left_pons_activity, left_momentum_stability
       FROM battles WHERE left_ticker = 'NVDA' OR right_ticker = 'NVDA'`,
    );

    const stored = rows.rows[0];
    expect(stored).toBeDefined();
    for (const value of Object.values(stored ?? {})) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('');
    }
  });

  it('is called repeatedly and does not duplicate anything', async () => {
    // The loop saves on every transition and every tick that changed something.
    const round = openRound();
    await store.saveState(round);
    await store.saveState(round);
    await store.saveState(lockRound(round, at(60_000), []));

    const battles = await pg.query<{ count: string }>('SELECT count(*) AS count FROM battles');
    const rounds = await pg.query<{ count: string; state: string }>(
      'SELECT count(*) AS count, min(state::text) AS state FROM rounds',
    );

    expect(Number(battles.rows[0]?.count)).toBe(5);
    expect(Number(rounds.rows[0]?.count)).toBe(1);
    expect(rounds.rows[0]?.state).toBe('BATTLE_LIVE');
  });

  it('never moves the clock after the round opened', async () => {
    // §23.5 makes those instants a property of the round. An upsert that
    // rewrote them would let a service running late redefine when picks closed.
    //
    // The second clock is a valid one for a later round, not a malformed one:
    // the schema already refuses a pick phase that is not exactly a minute
    // (§3.2), and a test that tripped that constraint would be checking
    // PostgreSQL rather than this adapter.
    const round = openRound();
    await store.saveState(round);
    const before = await pg.query<{ lock_at: Date }>('SELECT lock_at FROM rounds');

    await store.saveState({
      ...round,
      clock: clockForRound(at(600_000), 1, at(600_000)),
    });
    const after = await pg.query<{ lock_at: Date }>('SELECT lock_at FROM rounds');

    expect(after.rows[0]?.lock_at).toEqual(before.rows[0]?.lock_at);
  });
});

describe('saving a finalization', () => {
  it('writes five results that satisfy the schema constraints', async () => {
    // The point of using real PostgreSQL: `battle_results` requires the four
    // components to sum to a hundred points and each weight to its §12 share.
    // A column mapped to the wrong parameter is refused here rather than stored.
    const round = openRound();
    await store.saveState(round);
    await store.saveFinalization(finishedRound(round, 6));

    const results = await pg.query<{ count: string }>(
      'SELECT count(*) AS count FROM battle_results',
    );
    expect(Number(results.rows[0]?.count)).toBe(5);
  });

  it('marks the round finalized with a timestamp', async () => {
    const round = openRound();
    await store.saveState(round);
    await store.saveFinalization(finishedRound(round, 3));

    const rows = await pg.query<{ state: string; finalized_at: Date | null }>(
      'SELECT state, finalized_at FROM rounds',
    );
    expect(rows.rows[0]?.state).toBe('FINALIZED');
    expect(rows.rows[0]?.finalized_at).not.toBeNull();
  });

  it('credits War Points once, however many times it is retried', async () => {
    // §25 makes finalization exactly-once. The ledger's unique index is what
    // enforces it — the second attempt conflicts rather than crediting again,
    // and the handler treats that as success.
    const round = openRound();
    const finalization = finishedRound(round, 9);
    await store.saveState(round);

    await store.saveFinalization(finalization);
    const first = await pg.query<{ count: string }>('SELECT count(*) AS count FROM wp_ledger');
    await store.saveFinalization(finalization);
    await store.saveFinalization(finalization);
    const after = await pg.query<{ count: string }>('SELECT count(*) AS count FROM wp_ledger');

    expect(Number(first.rows[0]?.count)).toBeGreaterThan(0);
    expect(Number(after.rows[0]?.count)).toBe(Number(first.rows[0]?.count));
  });

  it('creates a wallet profile for a player it has never seen', async () => {
    // The ledger references `wallet_profiles`, and a player's first round is not
    // an error. §49.2 makes the profile's aggregates rebuildable from the
    // ledger, so creating an empty one loses nothing.
    const round = openRound();
    await store.saveState(round);
    await store.saveFinalization(finishedRound(round, 4));

    const wallets = await pg.query<{ count: string }>(
      'SELECT count(*) AS count FROM wallet_profiles',
    );
    expect(Number(wallets.rows[0]?.count)).toBeGreaterThan(0);
  });

  it('writes nothing at all when part of the write fails', async () => {
    // The property the transaction exists for. A result stored without its War
    // Points is a round that is partly finished, and the gap between two
    // statements is exactly where a crash lands.
    const round = openRound();
    await store.saveState(round);
    const finalization = finishedRound(round, 3);

    // A points value the ledger's CHECK refuses. The results are written before
    // the awards, so an adapter without a transaction would leave them behind.
    const broken = {
      ...finalization,
      awards: finalization.awards.map((award) => ({ ...award, points: 0 })),
    };

    await expect(store.saveFinalization(broken)).rejects.toThrow();

    const results = await pg.query<{ count: string }>(
      'SELECT count(*) AS count FROM battle_results',
    );
    expect(Number(results.rows[0]?.count)).toBe(0);
  });
});

describe('recovering from a restart', () => {
  it('has nothing to restore before a round is written', async () => {
    expect(await store.loadLatest()).toBeNull();
  });

  it('restores a round that has not started ticking', async () => {
    const round = openRound();
    await store.saveState(round);

    const restored = await store.loadLatest();

    expect(restored?.roundId).toBe(round.roundId);
    expect(restored?.state).toBe('PICK_OPEN');
    expect(restored?.battles).toHaveLength(5);
    expect(restored?.clock).toEqual(round.clock);
  });

  it('restores the confidence snapshot whole', async () => {
    // §11 prices an upset from the label and §27.5 draws the four sub-signals.
    // A restore that recovered only the label would resume a round whose intel
    // panel was empty and whose awards still depended on it.
    const round = openRound();
    await store.saveState(round);

    const restored = await store.loadLatest();
    const original = new Map(round.battles.map((b) => [b.setup.battleId, b.setup]));

    for (const battle of restored?.battles ?? []) {
      expect(battle.setup.leftIntel).toEqual(original.get(battle.setup.battleId)?.leftIntel);
      expect(battle.setup.rightIntel).toEqual(original.get(battle.setup.battleId)?.rightIntel);
    }
  });

  it('resumes a live battle exactly where it stopped', async () => {
    // The property §25 exists for. Score alone is not enough: a process that
    // came back with a fresh momentum window would read the next tick's
    // velocity against zero, and §13.3 would call an ordinary lead a comeback.
    const round = openRound();
    let live = lockRound(round, at(60_000), []);
    for (const battle of live.battles) {
      live = tickBattle(
        live,
        battle.setup.battleId,
        tick(120_000, { left: side({ windowReturn: 1_500_000n }) }),
        CONFIG,
      );
    }
    for (const battle of live.battles) {
      live = tickBattle(
        live,
        battle.setup.battleId,
        tick(180_000, { left: side({ windowReturn: 900_000n }) }),
        CONFIG,
      );
    }
    await store.saveState(live);

    const restored = await store.loadLatest();
    const before = live.battles[0];
    const after = restored?.battles.find((b) => b.setup.battleId === before?.setup.battleId);

    expect(after?.tickSequence).toBe(before?.tickSequence);
    expect(after?.leftScoreScaled).toBe(before?.leftScoreScaled);
    expect(after?.rightScoreScaled).toBe(before?.rightScoreScaled);
    expect(after?.momentum).toEqual(before?.momentum);
    expect(after?.evidenceHash).toBe(before?.evidenceHash);
    expect(after?.lastTickAt).toBe(before?.lastTickAt);
  });

  it('restores the last observation each side was scored from', async () => {
    // §12.6 scores from the last accepted observation, so a restart that lost
    // it would resume from an empty window and score the next tick against
    // nothing.
    const round = openRound();
    let live = lockRound(round, at(60_000), []);
    const inputs = side({ windowReturn: 1_234_567n, relativeVolume: 2_345_678n });
    for (const battle of live.battles) {
      live = tickBattle(live, battle.setup.battleId, tick(120_000, { left: inputs }), CONFIG);
    }
    await store.saveState(live);

    const restored = await store.loadLatest();

    expect(restored?.battles[0]?.lastLeft).toEqual(inputs);
  });

  it('keeps scaled integers exact across the round trip', async () => {
    // §66.4: a bigint written as a JSON number would round past 2^53 and a
    // replayed battle would diverge from the one that was fought. The value
    // below is chosen to be past that boundary.
    const round = openRound();
    let live = lockRound(round, at(60_000), []);
    const huge = side({ windowReturn: 9_007_199_254_740_993n });
    for (const battle of live.battles) {
      live = tickBattle(live, battle.setup.battleId, tick(120_000, { left: huge }), CONFIG);
    }
    await store.saveState(live);

    const restored = await store.loadLatest();

    expect(restored?.battles[0]?.lastLeft?.windowReturn).toBe(9_007_199_254_740_993n);
  });

  it('checkpoints once per tick however often the state is saved', async () => {
    // The loop saves after every tick and after every transition. A transition
    // that scored nothing must not leave a second checkpoint at a sequence that
    // already has one, or the evidence trail would claim ticks that never
    // happened (§26).
    const round = openRound();
    let live = lockRound(round, at(60_000), []);
    for (const battle of live.battles) {
      live = tickBattle(live, battle.setup.battleId, tick(120_000), CONFIG);
    }
    await store.saveState(live);
    await store.saveState(live);
    await store.saveState(live);

    const rows = await pg.query<{ count: string }>(
      'SELECT count(*) AS count FROM battle_tick_evidence',
    );
    expect(Number(rows.rows[0]?.count)).toBe(5);
  });

  it('restores a finalized round as finalized', async () => {
    // A restart must not resume a round that already paid out. §22 makes the
    // decision to open the next round a transition the caller takes, so the
    // store's job is only to say truthfully what the last one was.
    const round = openRound();
    await store.saveState(round);
    await store.saveFinalization(finishedRound(round, 3));

    expect((await store.loadLatest())?.state).toBe('FINALIZED');
  });
});

describe('reading a result back', () => {
  /**
   * The lookup behind `GET /v1/battles/:battleId/result` (§47.1, §27.8).
   *
   * Read through a query rather than off the object that wrote it, because the
   * instance answering a shared link is usually not the one that fought the
   * battle — and, after a restart, never is.
   */

  it('has nothing for a battle that has not finished', async () => {
    const round = openRound();
    await store.saveState(round);

    expect(await readFinalizedResult(database(pg), round.battles[0]!.setup.battleId)).toBeNull();
  });

  it('has nothing for a battle it has never heard of', async () => {
    expect(await readFinalizedResult(database(pg), 'battle-nobody-fought')).toBeNull();
  });

  it('returns what the finalization wrote', async () => {
    const round = openRound();
    await store.saveState(round);
    const finalization = finishedRound(round, 6);
    await store.saveFinalization(finalization);

    const written = finalization.results[0]!;
    const read = await readFinalizedResult(database(pg), written.battleId);

    expect(read).toEqual(written);
  });

  it('keeps the four components exact', async () => {
    // §12 splits a hundred points 45/25/20/10 and the database enforces it. A
    // component read back through the wrong column would still sum to a
    // hundred, so the check is per component rather than on the total.
    const round = openRound();
    await store.saveState(round);
    const finalization = finishedRound(round, 2);
    await store.saveFinalization(finalization);

    const written = finalization.results[0]!;
    const read = await readFinalizedResult(database(pg), written.battleId);

    expect(read?.leftScore).toEqual(written.leftScore);
    expect(read?.rightScore).toEqual(written.rightScore);
  });

  it('gives back the instant it was finalized, not a broken date', async () => {
    // `TIMESTAMPTZ` comes back as a `Date` from both drivers this runs on, and
    // an earlier version of this function ran that through a string coercion
    // that threw on one and produced `NaN` on the other.
    const round = openRound();
    await store.saveState(round);
    const finalization = finishedRound(round, 8);
    await store.saveFinalization(finalization);

    const read = await readFinalizedResult(database(pg), finalization.results[0]!.battleId);

    expect(Number.isFinite(read?.finalizedAt)).toBe(true);
    expect(read?.finalizedAt).toBe(finalization.results[0]!.finalizedAt);
  });
});
