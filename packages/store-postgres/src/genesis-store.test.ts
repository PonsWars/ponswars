import { PGlite } from '@electric-sql/pglite';
import {
  ENTROPY_TARGET_DISTANCE,
  GenesisFlow,
  genesisRequestId,
  warThreshold,
  type GenesisChain,
} from '@ponswars/genesis-service';
import {
  baseUnits,
  tokenDecimals,
  utcTimestamp,
  walletAddress,
  type WalletAddress,
} from '@ponswars/shared-types';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresCardHoldings } from './card-holdings.js';
import { PostgresGenesisStore } from './genesis-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * Genesis claims against real PostgreSQL, through the flow that writes them.
 *
 * `PGlite` applies the actual migrations, so the rules this store leans on —
 * one request per wallet, a target block from the start, a claim nobody can
 * update — are the database's, and a test that breaks one fails on the server.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const WAR = tokenDecimals(18);
const wallet = (n: number): WalletAddress => walletAddress(`0x${n.toString(16).padStart(40, '0')}`);

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
let store: PostgresGenesisStore;
let blocks: GenesisChain & { head: number; finalized: number };
let genesis: GenesisFlow;

beforeEach(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  db = database(pg);
  store = new PostgresGenesisStore(db);
  const state = {
    head: 62_000_000,
    finalized: 61_990_000,
    headBlock: () => Promise.resolve(state.head),
    finalizedBlock: (number: number) =>
      Promise.resolve(
        number > state.finalized
          ? null
          : { number, hash: `0x${number.toString(16).padStart(64, '0')}` },
      ),
  };
  blocks = state;
  let now = 1_800_000_000_000;
  genesis = new GenesisFlow({
    repository: store,
    chain: blocks,
    warBalanceOf: () => Promise.resolve(warThreshold(WAR)),
    warDecimals: WAR,
    secretAvailable: () => Promise.resolve(false),
    now: () => utcTimestamp((now += 1_000)),
  });
});

describe('a Genesis claim in PostgreSQL', () => {
  it('keeps a pending request with the block it was bound to', async () => {
    const status = await genesis.request(wallet(1));

    expect(status).toEqual({
      kind: 'PENDING_FINALITY',
      requestId: genesisRequestId(wallet(1)),
      targetBlock: 62_000_000 + ENTROPY_TARGET_DISTANCE,
    });
    expect((await store.find(wallet(1)))?.request.entropyTargetBlock).toBe(
      62_000_000 + ENTROPY_TARGET_DISTANCE,
    );
  });

  it('keeps the first target block when a request is opened again (§76.1)', async () => {
    await genesis.request(wallet(1));
    const first = await store.find(wallet(1));
    if (first === null) throw new Error('expected a request');

    const reopened = await store.open({ ...first.request, entropyTargetBlock: 99_999_999 });

    expect(reopened.entropyTargetBlock).toBe(first.request.entropyTargetBlock);
  });

  it('records the card once its block is final, and the card can be deployed', async () => {
    await genesis.request(wallet(1));
    blocks.finalized = blocks.head + ENTROPY_TARGET_DISTANCE;

    const ready = await genesis.status(wallet(1));
    if (ready.kind !== 'READY') throw new Error(`expected a card, got ${ready.kind}`);

    expect(ready.claim).toMatchObject({
      genesisId: '000001',
      cardInstanceId: 'card-000001',
      wallet: wallet(1),
      entropyBlock: 62_000_000 + ENTROPY_TARGET_DISTANCE,
      secretAvailable: false,
    });
    // The card the claim dealt is the one a pick can now arm (§40.7).
    expect(await new PostgresCardHoldings(db).cardOf(wallet(1))).toEqual({
      cardInstanceId: 'card-000001',
      cardType: ready.claim.cardType,
      remainingUses: ready.claim.initialUses,
    });
    const profile = await pg.query<{ genesis_claimed: boolean }>(
      'SELECT genesis_claimed FROM wallet_profiles WHERE wallet = $1',
      [wallet(1)],
    );
    expect(profile.rows[0]?.genesis_claimed).toBe(true);
  });

  it('reads back exactly the claim it recorded, and records it once', async () => {
    await genesis.request(wallet(1));
    blocks.finalized = Number.MAX_SAFE_INTEGER;

    const first = await genesis.status(wallet(1));
    const again = await genesis.status(wallet(1));

    expect(again).toEqual(first);
    const claims = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM genesis_claims');
    expect(claims.rows[0]?.n).toBe(1);
  });

  it('numbers claims in the order they land', async () => {
    blocks.finalized = Number.MAX_SAFE_INTEGER;
    const ids: string[] = [];
    for (const n of [7, 3, 9]) {
      const status = await genesis.request(wallet(n));
      if (status.kind !== 'READY') throw new Error(`expected a card, got ${status.kind}`);
      ids.push(status.claim.genesisId);
    }

    expect(ids).toEqual(['000001', '000002', '000003']);
  });

  it('refuses to change or remove a claim (§9)', async () => {
    blocks.finalized = Number.MAX_SAFE_INTEGER;
    await genesis.request(wallet(1));

    await expect(pg.query("UPDATE genesis_claims SET card = 'GOLDEN_ARMY'")).rejects.toThrow(
      /immutable/,
    );
    await expect(pg.query('DELETE FROM genesis_claims')).rejects.toThrow(/immutable/);
  });

  it('refuses a request written without its target block', async () => {
    await pg.query('INSERT INTO wallet_profiles (wallet) VALUES ($1)', [wallet(1)]);

    await expect(
      pg.query("INSERT INTO genesis_requests (request_id, wallet) VALUES ('r', $1)", [wallet(1)]),
    ).rejects.toThrow(/entropy_target_block/);
  });

  it('commits a held-back result without recording a card', async () => {
    await genesis.request(wallet(1));
    const pending = await store.find(wallet(1));
    if (pending === null) throw new Error('expected a request');
    const hash = `0x${'ab'.repeat(32)}`;

    await store.commit({
      ...pending.request,
      state: 'COMMITTED',
      entropyBlockHash: hash,
      committedAt: utcTimestamp(1_800_000_100_000),
    });

    const stored = await store.find(wallet(1));
    expect(stored?.request.state).toBe('COMMITTED');
    expect(stored?.request.entropyBlockHash).toBe(hash);
    expect(stored?.claim).toBeNull();
    expect((await genesis.status(wallet(1))).kind).toBe('SECRET_RESERVATION_PENDING');
  });

  it('writes nothing for a wallet under the threshold', async () => {
    const poor = new GenesisFlow({
      repository: store,
      chain: blocks,
      warBalanceOf: () => Promise.resolve(baseUnits(0n)),
      warDecimals: WAR,
      secretAvailable: () => Promise.resolve(false),
      now: () => utcTimestamp(1_800_000_000_000),
    });

    expect((await poor.request(wallet(2))).kind).toBe('NOT_ELIGIBLE_BALANCE');
    expect(await store.find(wallet(2))).toBeNull();
  });
});
