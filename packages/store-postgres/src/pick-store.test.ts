import { PGlite } from '@electric-sql/pglite';
import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  finalizeRound,
  lockRound,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import {
  RATIO_SCALE,
  clockForRound,
  roundIdFor,
  type ConfidenceCalibration,
  type ConfidenceLookback,
} from '@ponswars/battle-math';
import { PicksLockedError, type SubmittedPick } from '@ponswars/round-service';
import {
  ACTIVE_TICKERS,
  clientRequestId,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresCardHoldings } from './card-holdings.js';
import { PostgresPickStore } from './pick-store.js';
import { PostgresRoundStore } from './round-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * Picks against real PostgreSQL.
 *
 * `PGlite` applies the actual migrations, so the primary key that makes a pick
 * one-per-wallet-per-round, the foreign keys to the round, and the lock column
 * are all enforced by the server rather than assumed by the test.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

// A real PostgreSQL, compiled to WebAssembly, with every migration applied
// before each test: two to three seconds apiece on a quiet machine, and past
// vitest's five-second default on a busy one. The limit is raised for this file
// rather than for the whole suite, so a pure test that hangs still fails fast.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const EPOCH = utcTimestamp(1_800_000_000_000);

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

const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

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

function openRound(): RoundEngineState {
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
  return { ...round, state: 'PICK_OPEN' };
}

let pg: PGlite;
let db: SqlDatabase;
let store: PostgresPickStore;
let round: RoundEngineState;

beforeEach(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  db = database(pg);
  round = openRound();
  // Picks are stored against the round's row, which the driver writes the
  // moment a round opens.
  await new PostgresRoundStore(db).saveState(round);
  store = new PostgresPickStore(db);
});

afterEach(async () => {
  await pg.close();
});

/** A pick in one of the round's battles, on one of its sides. */
function pick(
  who: WalletAddress,
  key: string,
  options: {
    readonly battle?: number;
    readonly side?: 'left' | 'right';
    readonly at?: number;
  } = {},
): SubmittedPick {
  const battle = round.battles[options.battle ?? 0];
  if (battle === undefined) {
    throw new Error('a round always has five battles');
  }
  return {
    wallet: who,
    roundId: round.roundId,
    battleId: battle.setup.battleId,
    backedTicker: options.side === 'right' ? battle.setup.right : battle.setup.left,
    cardDecision: 'SAVE',
    receivedAt: utcTimestamp(EPOCH + (options.at ?? 1_000)),
    clientRequestId: clientRequestId(key),
  };
}

describe('recording a pick', () => {
  it('stores it and finds it again', async () => {
    const first = pick(wallet(1), 'req-1');

    expect(await store.submit(first)).toEqual({ stored: first, replayed: false });
    expect(await store.find(round.roundId, wallet(1))).toEqual(first);
    expect(await store.count(round.roundId)).toBe(1);
  });

  it('survives the process that wrote it', async () => {
    // The reason this adapter exists: the in-memory store the server used lost
    // every pick of a round when the process restarted.
    const first = pick(wallet(1), 'req-1');
    await store.submit(first);

    expect(await new PostgresPickStore(db).find(round.roundId, wallet(1))).toEqual(first);
  });

  it('replaces a change rather than adding a second pick, and counts the revision', async () => {
    await store.submit(pick(wallet(1), 'req-1'));
    const changed = pick(wallet(1), 'req-2', { battle: 3, side: 'right', at: 2_000 });

    expect(await store.submit(changed)).toEqual({ stored: changed, replayed: false });
    expect(await store.find(round.roundId, wallet(1))).toEqual(changed);
    expect(await store.count(round.roundId)).toBe(1);

    const { rows } = await db.query('SELECT revision FROM player_picks WHERE wallet = $1', [
      wallet(1),
    ]);
    expect(rows[0]?.['revision']).toBe(2);
  });
});

describe('a retried request', () => {
  it('is a replay, and writes nothing', async () => {
    const first = pick(wallet(1), 'req-1');
    await store.submit(first);

    expect(await store.submit({ ...first, receivedAt: utcTimestamp(EPOCH + 9_000) })).toEqual({
      stored: first,
      replayed: true,
    });
  });

  it('cannot overwrite the decision that replaced it', async () => {
    // A player backs LEFT, changes to RIGHT, and the first request is retried
    // by a flaky connection afterwards. They keep RIGHT.
    const first = pick(wallet(1), 'req-1', { side: 'left' });
    const second = pick(wallet(1), 'req-2', { side: 'right', at: 2_000 });
    await store.submit(first);
    await store.submit(second);

    const retry = await store.submit(first);

    expect(retry).toEqual({ stored: first, replayed: true });
    expect(await store.find(round.roundId, wallet(1))).toEqual(second);
  });

  it('is scoped to the wallet: another wallet using the same key is its own request', async () => {
    await store.submit(pick(wallet(1), 'shared-key'));
    const other = pick(wallet(2), 'shared-key', { side: 'right' });

    expect(await store.submit(other)).toEqual({ stored: other, replayed: false });
    expect(await store.count(round.roundId)).toBe(2);
  });
});

describe('withdrawing', () => {
  it('removes the pick and releases its key, so the same pick again is a new decision', async () => {
    const first = pick(wallet(1), 'req-1');
    await store.submit(first);

    expect(await store.withdraw(round.roundId, wallet(1))).toBe(true);
    expect(await store.find(round.roundId, wallet(1))).toBeNull();
    expect(await store.submit(first)).toEqual({ stored: first, replayed: false });
  });

  it('says there was nothing to withdraw', async () => {
    expect(await store.withdraw(round.roundId, wallet(1))).toBe(false);
  });
});

describe('the card decision', () => {
  it('changes only the decision', async () => {
    const first = pick(wallet(1), 'req-1');
    await store.submit(first);
    const at = utcTimestamp(EPOCH + 5_000);

    expect(await store.decideCard(round.roundId, wallet(1), 'USE', at)).toEqual({
      ...first,
      cardDecision: 'USE',
      receivedAt: at,
    });
  });

  it('has nothing to decide without a pick', async () => {
    expect(await store.decideCard(round.roundId, wallet(1), 'USE', utcTimestamp(EPOCH))).toBeNull();
  });
});

describe('the lock', () => {
  it('freezes the set the engine reads, in one order', async () => {
    await store.submit(pick(wallet(3), 'c', { battle: 1 }));
    await store.submit(pick(wallet(1), 'a', { battle: 0 }));
    await store.submit(pick(wallet(2), 'b', { battle: 2, side: 'right' }));

    const locked = await store.lockedPicks(round.roundId);

    // Cards at lock have their own tests below; this one is the order and the
    // columns the engine is handed.
    expect(locked.map((entry) => entry.wallet)).toEqual([wallet(1), wallet(2), wallet(3)]);
    expect(locked[1]).toEqual({
      wallet: wallet(2),
      battleId: round.battles[2]?.setup.battleId,
      backedTicker: round.battles[2]?.setup.right,
      cardDeployed: false,
    });
  });

  it('refuses every change afterwards', async () => {
    await store.submit(pick(wallet(1), 'req-1'));
    await store.lockedPicks(round.roundId);

    await expect(store.submit(pick(wallet(2), 'late'))).rejects.toBeInstanceOf(PicksLockedError);
    await expect(store.submit(pick(wallet(1), 'change', { side: 'right' }))).rejects.toBeInstanceOf(
      PicksLockedError,
    );
    await expect(store.withdraw(round.roundId, wallet(1))).rejects.toBeInstanceOf(PicksLockedError);
    await expect(
      store.decideCard(round.roundId, wallet(1), 'USE', utcTimestamp(EPOCH)),
    ).rejects.toBeInstanceOf(PicksLockedError);
    expect(await store.count(round.roundId)).toBe(1);
  });

  it('reads the same frozen set again after a restart', async () => {
    await store.submit(pick(wallet(1), 'req-1'));
    const first = await store.lockedPicks(round.roundId);

    expect(await new PostgresPickStore(db).lockedPicks(round.roundId)).toEqual(first);
  });

  it('records when the picks froze, and what each one froze as', async () => {
    await store.submit(pick(wallet(1), 'req-1'));
    await store.lockedPicks(round.roundId);

    const rounds = await db.query('SELECT picks_locked_at FROM rounds WHERE round_id = $1', [
      round.roundId,
    ]);
    const picks = await db.query(
      'SELECT locked_at, locked_ticker FROM player_picks WHERE wallet = $1',
      [wallet(1)],
    );
    expect(rounds.rows[0]?.['picks_locked_at']).not.toBeNull();
    expect(picks.rows[0]?.['locked_at']).not.toBeNull();
    expect(picks.rows[0]?.['locked_ticker']).toBe(round.battles[0]?.setup.left);
  });

  it('refuses picks for a round that was never stored', async () => {
    await expect(
      store.submit({ ...pick(wallet(1), 'req-1'), roundId: toRoundId(roundIdFor(9)) }),
    ).rejects.toBeInstanceOf(PicksLockedError);
  });
});

describe('a card at lock (§3.2, §40.7)', () => {
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

  /** Records a Genesis claim and its card, as the claim flow would. */
  async function seedCard(who: WalletAddress, remaining: number): Promise<void> {
    const n = who.slice(-4);
    await db.query('INSERT INTO wallet_profiles (wallet) VALUES ($1) ON CONFLICT DO NOTHING', [
      who,
    ]);
    await db.query('INSERT INTO genesis_requests (request_id, wallet) VALUES ($1, $2)', [
      `request-${n}`,
      who,
    ]);
    await db.query(
      `INSERT INTO genesis_claims (genesis_id, wallet, request_id, seed, slot, secret_available,
                                   rarity, card, initial_uses, rng_version)
       VALUES ($1, $2, $3, 'seed', 1, false, 'RARE', 'BULL_RUN', 3, 'genesis-rng-v1')`,
      [`genesis-${n}`, who, `request-${n}`],
    );
    await db.query(
      `INSERT INTO cards (card_instance_id, wallet, genesis_id, rarity, card, initial_uses,
                          remaining_uses, depleted_at)
       VALUES ($1, $2, $3, 'RARE', 'BULL_RUN', 3, $4, $5)`,
      [
        `card-${n}`,
        who,
        `genesis-${n}`,
        remaining,
        remaining === 0 ? new Date().toISOString() : null,
      ],
    );
  }

  const armed = (who: WalletAddress, key: string, battle = 0): SubmittedPick => ({
    ...pick(who, key, { battle }),
    cardDecision: 'USE',
  });

  async function remaining(who: WalletAddress): Promise<unknown> {
    const { rows } = await db.query(
      'SELECT remaining_uses, depleted_at FROM cards WHERE wallet = $1',
      [who],
    );
    return rows[0];
  }

  it('deploys a held card and spends exactly one charge, however often the lock is read', async () => {
    await seedCard(wallet(1), 3);
    await store.submit(armed(wallet(1), 'a'));

    const first = await store.lockedPicks(round.roundId);
    await store.lockedPicks(round.roundId);
    await new PostgresPickStore(db).lockedPicks(round.roundId);

    expect(first[0]?.cardDeployed).toBe(true);
    expect(await remaining(wallet(1))).toEqual({ remaining_uses: 2, depleted_at: null });
    const ledger = await db.query(`SELECT event, delta FROM card_usage_ledger WHERE wallet = $1`, [
      wallet(1),
    ]);
    expect(ledger.rows).toEqual([{ event: 'DEPLOY', delta: -1 }]);
  });

  it('marks the card depleted in the statement that spends its last charge', async () => {
    await seedCard(wallet(1), 1);
    await store.submit(armed(wallet(1), 'a'));

    const locked = await store.lockedPicks(round.roundId);

    expect(locked[0]?.cardDeployed).toBe(true);
    const card = (await remaining(wallet(1))) as { remaining_uses: number; depleted_at: unknown };
    expect(card.remaining_uses).toBe(0);
    expect(card.depleted_at).not.toBeNull();
  });

  it('locks an armed card nobody holds as saved, so the engine never credits it', async () => {
    // The API refuses to arm one; this is the frozen set the engine scores, and
    // a card must not reach it by any route — a pick written before the check
    // existed, or by anything that bypasses the API.
    await store.submit(armed(wallet(2), 'b'));

    const locked = await store.lockedPicks(round.roundId);

    expect(locked[0]?.cardDeployed).toBe(false);
    const { rows } = await db.query(
      'SELECT locked_card_decision FROM player_picks WHERE wallet = $1',
      [wallet(2)],
    );
    expect(rows[0]).toEqual({ locked_card_decision: 'SAVE' });
  });

  it('locks an armed card with no charge left as saved, and spends nothing', async () => {
    await seedCard(wallet(3), 0);
    await store.submit(armed(wallet(3), 'c'));

    const locked = await store.lockedPicks(round.roundId);

    expect(locked[0]?.cardDeployed).toBe(false);
    expect((await remaining(wallet(3))) as { remaining_uses: number }).toMatchObject({
      remaining_uses: 0,
    });
  });

  it('is refunded once when its battle voids (§4.4)', async () => {
    await seedCard(wallet(1), 3);
    await store.submit(armed(wallet(1), 'a'));
    const rounds = new PostgresRoundStore(db);
    const locked = lockRound(
      { ...round, state: 'PICK_OPEN' },
      round.clock.lockAt,
      await store.lockedPicks(round.roundId),
    );
    await rounds.saveState(locked);
    // No battle is ever scored, so every one of them voids.
    const finalization = finalizeRound(
      locked,
      round.clock.battleEndAt,
      `0x${'ab'.repeat(32)}`,
      CONFIG,
    );
    expect(finalization.voided).toContain(round.battles[0]?.setup.battleId);

    await rounds.saveFinalization(finalization);
    await rounds.saveFinalization(finalization);

    expect(await remaining(wallet(1))).toEqual({ remaining_uses: 3, depleted_at: null });
    const ledger = await db.query(
      `SELECT event, delta FROM card_usage_ledger WHERE wallet = $1 ORDER BY entry_id`,
      [wallet(1)],
    );
    expect(ledger.rows).toEqual([
      { event: 'DEPLOY', delta: -1 },
      { event: 'VOID_REFUND', delta: 1 },
    ]);
  });
});

describe('card holdings', () => {
  it('answers from the cards table, and nothing for a wallet with no card', async () => {
    const holdings = new PostgresCardHoldings(db);
    await db.query('INSERT INTO wallet_profiles (wallet) VALUES ($1)', [wallet(7)]);
    await db.query("INSERT INTO genesis_requests (request_id, wallet) VALUES ('r7', $1)", [
      wallet(7),
    ]);
    await db.query(
      `INSERT INTO genesis_claims (genesis_id, wallet, request_id, seed, slot, secret_available,
                                   rarity, card, initial_uses, rng_version)
       VALUES ('g7', $1, 'r7', 'seed', 7, false, 'EPIC', 'WAR_MACHINE', 5, 'genesis-rng-v1')`,
      [wallet(7)],
    );
    await db.query(
      `INSERT INTO cards (card_instance_id, wallet, genesis_id, rarity, card, initial_uses, remaining_uses)
       VALUES ('c7', $1, 'g7', 'EPIC', 'WAR_MACHINE', 5, 4)`,
      [wallet(7)],
    );

    expect(await holdings.cardOf(wallet(7))).toEqual({ cardInstanceId: 'c7', remainingUses: 4 });
    expect(await holdings.cardOf(wallet(8))).toBeNull();
  });
});
