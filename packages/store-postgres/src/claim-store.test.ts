import { PGlite } from '@electric-sql/pglite';
import { walletAddress, type WalletAddress } from '@ponswars/shared-types';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresClaimStore } from './claim-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * Claims recorded from the chain, against real PostgreSQL.
 *
 * The rules this store leans on are the database's — one claim per wallet per
 * distribution, a claim only for a window this deployment knows — so a test
 * that breaks one breaks on the server too.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const WALLET = walletAddress('0x00000000000000000000000000000000000000aa');
const OTHER = walletAddress('0x00000000000000000000000000000000000000bb');

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

const claim = (distributionId: bigint, wallet: WalletAddress, block: number) => ({
  distributionId,
  wallet,
  amount: 400n,
  blockNumber: block,
  transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
  logIndex: 1,
});

let pg: PGlite;
let db: SqlDatabase;
let store: PostgresClaimStore;

beforeEach(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  db = database(pg);
  store = new PostgresClaimStore(db);
  const windowStart = Date.now() - 25 * 3_600_000;
  // A published allocation for WALLET in distribution 8: what a claim claims.
  await db.query(
    `INSERT INTO distribution_windows
       (distribution_id, window_start, window_end, state, minimum_claim,
        merkle_root, publication_tx, published_at)
     VALUES ('8', $1, $2, 'PUBLISHED', 1, $3, $4, now())`,
    [
      // One instant, two ends: read twice, the window is not exactly the
      // twenty-four hours §16.2 fixes, and the database says so.
      new Date(windowStart).toISOString(),
      new Date(windowStart + 24 * 3_600_000).toISOString(),
      `0x${'11'.repeat(32)}`,
      `0x${'22'.repeat(32)}`,
    ],
  );
  await db.query('INSERT INTO wallet_profiles (wallet) VALUES ($1)', [WALLET]);
  await db.query(
    `INSERT INTO reward_allocations
       (distribution_id, wallet, window_war_points, weight, amount, state,
        merkle_leaf, merkle_proof)
     VALUES ('8', $1, 64, 8, 400, 'PUBLISHED', $2, $3::jsonb)`,
    [WALLET, `0x${'33'.repeat(32)}`, '[]'],
  );
});

afterEach(async () => {
  await pg.close();
});

describe('recording claims', () => {
  it('records each claim once, however many times the log is read', async () => {
    expect(await store.record([claim(8n, WALLET, 100)])).toBe(1);
    expect(await store.record([claim(8n, WALLET, 100)])).toBe(0);

    expect([...(await store.claimedBy(WALLET))]).toEqual(['8']);
    expect([...(await store.claimedBy(OTHER))]).toEqual([]);
  });

  it('drops a claim with no allocation behind it', async () => {
    // Another deployment's distribution on the same contract says nothing
    // about this one's players, and nothing here was allocated to claim.
    expect(await store.record([claim(99n, WALLET, 120)])).toBe(0);
    expect([...(await store.claimedBy(WALLET))]).toEqual([]);
  });
});

describe('the reader’s position', () => {
  it('is unknown until something records one', async () => {
    expect(await store.cursor('rewards')).toBeNull();
  });

  it('moves forward and never back', async () => {
    await store.advance('rewards', 1_000n);
    await store.advance('rewards', 2_000n);
    await store.advance('rewards', 1_500n);

    expect(await store.cursor('rewards')).toBe(2_000n);
    expect(await store.cursor('market')).toBeNull();
  });
});
