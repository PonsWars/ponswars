import { PGlite } from '@electric-sql/pglite';
import { AuthService, type AuthPolicy } from '@ponswars/auth';
import { utcTimestamp, walletAddress, type UtcTimestamp } from '@ponswars/shared-types';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAuthStore } from './auth-store.js';
import type { SqlDatabase, SqlRow } from './sql.js';

/**
 * The auth store against real PostgreSQL.
 *
 * `PGlite` is PostgreSQL compiled to WebAssembly, so the migration below is
 * applied by the actual server and every constraint in it is enforced. That is
 * the point here more than anywhere else in this package: the single-use rule
 * is a conditional `UPDATE`, and only a real database can be asked whether two
 * callers racing for one nonce get one answer between them.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);
const WALLET = walletAddress(account.address);

const POLICY: AuthPolicy = {
  challengeTtlMs: 300_000,
  sessionTtlMs: 3_600_000,
  domain: 'ponswars.test',
  uri: 'https://ponswars.test',
  chainId: 8453,
};

let clock = 1_800_000_000_000;
const now = (): UtcTimestamp => utcTimestamp(clock);

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
let store: PostgresAuthStore;
let auth: AuthService;

beforeEach(async () => {
  clock = 1_800_000_000_000;
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  store = new PostgresAuthStore(database(pg));
  auth = new AuthService({ store, policy: POLICY, now });
});

afterEach(async () => {
  await pg.close();
});

async function signIn(): Promise<{ nonce: string; message: string; signature: string }> {
  const challenge = await auth.challenge(WALLET);
  return {
    nonce: challenge.nonce,
    message: challenge.message,
    signature: await account.signMessage({ message: challenge.message }),
  };
}

describe('a challenge', () => {
  it('is answered once and never again', async () => {
    const { nonce, signature } = await signIn();

    const first = await auth.verify(nonce, signature);
    const second = await auth.verify(nonce, signature);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'NO_SUCH_CHALLENGE' });
  });

  it('is answered once even when two requests arrive together', async () => {
    // The property the whole table exists for. Both callers see an unused
    // challenge if consumption is a read followed by a write; the conditional
    // UPDATE is what makes exactly one of them win.
    const { nonce, signature } = await signIn();

    const [a, b] = await Promise.all([
      auth.verify(nonce, signature),
      auth.verify(nonce, signature),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('cannot be answered after it expires', async () => {
    const { nonce, signature } = await signIn();
    clock += POLICY.challengeTtlMs + 1;

    expect(await auth.verify(nonce, signature)).toEqual({
      ok: false,
      reason: 'NO_SUCH_CHALLENGE',
    });
  });

  it('is spent by a wrong signature too', async () => {
    const { nonce, message } = await signIn();
    const wrong = await privateKeyToAccount(`0x${'33'.repeat(32)}`).signMessage({ message });

    await auth.verify(nonce, wrong);

    const rows = await pg.query<{ used_at: Date | null }>('SELECT used_at FROM auth_challenges');
    expect(rows.rows[0]?.used_at).not.toBeNull();
  });
});

describe('a session', () => {
  async function live(): Promise<string> {
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    if (!result.ok) {
      throw new Error(`sign-in failed: ${result.reason}`);
    }
    return result.session.token;
  }

  it('is stored as a fingerprint and never as the token', async () => {
    const token = await live();

    const rows = await pg.query<{ token_fingerprint: string }>(
      'SELECT token_fingerprint FROM auth_sessions',
    );
    expect(rows.rows[0]?.token_fingerprint).not.toBe(token);
    expect(rows.rows[0]?.token_fingerprint).toHaveLength(64);
  });

  it('identifies the wallet that signed', async () => {
    expect(await auth.walletOf(await live())).toBe(WALLET);
  });

  it('survives a restart, because the process is not where it lives', async () => {
    // The reason this is in PostgreSQL rather than in memory: a deploy should
    // not sign everybody out, and two instances should agree about who is
    // signed in.
    const token = await live();

    const second = new AuthService({
      store: new PostgresAuthStore(database(pg)),
      policy: POLICY,
      now,
    });

    expect(await second.walletOf(token)).toBe(WALLET);
  });

  it('stops working the moment it is revoked', async () => {
    const token = await live();

    await auth.revoke(token);

    expect(await auth.walletOf(token)).toBeNull();
  });

  it('keeps the time of the first revocation', async () => {
    const token = await live();
    await auth.revoke(token);
    const first = await pg.query<{ revoked_at: Date }>('SELECT revoked_at FROM auth_sessions');

    clock += 60_000;
    await auth.revoke(token);
    const after = await pg.query<{ revoked_at: Date }>('SELECT revoked_at FROM auth_sessions');

    expect(after.rows[0]?.revoked_at).toEqual(first.rows[0]?.revoked_at);
  });

  it('rotates without a gap in which the client holds nothing', async () => {
    const token = await live();

    const rotated = await auth.rotate(token);

    expect(rotated).not.toBeNull();
    expect(await auth.walletOf(token)).toBeNull();
    expect(await auth.walletOf(rotated?.token ?? '')).toBe(WALLET);
  });

  it('ends everywhere at once when an operator says so', async () => {
    // §45.2: revocation after suspicious behaviour. One wallet, three devices.
    const tokens = [await live(), await live(), await live()];

    const ended = await store.revokeEverySession(WALLET, now());

    expect(ended).toBe(3);
    for (const token of tokens) {
      expect(await auth.walletOf(token)).toBeNull();
    }
  });

  it('leaves other wallets alone when one is revoked', async () => {
    const mine = await live();
    const other = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const theirs = await auth.challenge(other.address);
    const signature = await other.signMessage({ message: theirs.message });
    const session = await auth.verify(theirs.nonce, signature);

    await store.revokeEverySession(WALLET, now());

    expect(await auth.walletOf(mine)).toBeNull();
    expect(session.ok && (await auth.walletOf(session.session.token))).toBe(
      walletAddress(other.address),
    );
  });
});

describe('housekeeping', () => {
  it('removes what has expired and leaves what has not', async () => {
    const { nonce, signature } = await signIn();
    const session = await auth.verify(nonce, signature);
    await auth.challenge(WALLET);

    clock += POLICY.challengeTtlMs + 1;
    const removed = await auth.prune();

    expect(removed).toBe(2); // the used challenge and the unused one
    expect(session.ok && (await auth.walletOf(session.session.token))).toBe(WALLET);
  });
});
