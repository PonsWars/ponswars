import type { AuthStore, StoredChallenge, StoredSession } from '@ponswars/auth';
import { utcTimestamp, walletAddress, type UtcTimestamp } from '@ponswars/shared-types';
import type { SqlDatabase } from './sql.js';

/**
 * The `AuthStore` against PostgreSQL (§45.2, §49).
 *
 * The interesting line in the whole file is the `WHERE used_at IS NULL` in
 * `consumeChallenge`. Everything else is reading and writing rows; that one is
 * the reason these records are in a database rather than a `Map`.
 *
 * A challenge is single-use, and single-use has to survive two requests
 * arriving at the same moment at two different processes. A read followed by a
 * write cannot do that — both would read an unused challenge and both would
 * proceed. A conditional `UPDATE` on a primary key can, because the database
 * serialises the row: exactly one of them changes it, and the other gets no
 * rows back and is told the challenge does not exist.
 */
export class PostgresAuthStore implements AuthStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async saveChallenge(challenge: StoredChallenge): Promise<void> {
    await this.#db.query(
      `INSERT INTO auth_challenges (nonce, wallet, chain_id, message, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        challenge.nonce,
        challenge.wallet,
        challenge.chainId,
        challenge.message,
        iso(challenge.issuedAt),
        iso(challenge.expiresAt),
      ],
    );
  }

  async consumeChallenge(nonce: string, at: UtcTimestamp): Promise<StoredChallenge | null> {
    // One statement: claim it and read it back. `RETURNING` gives the row to
    // whichever caller won, and nothing to the one that did not.
    const { rows } = await this.#db.query(
      `UPDATE auth_challenges
          SET used_at = $2
        WHERE nonce = $1
          AND used_at IS NULL
          AND expires_at > $2
        RETURNING nonce, wallet, chain_id, message, issued_at, expires_at`,
      [nonce, iso(at)],
    );

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      nonce: text(row['nonce']),
      wallet: walletAddress(text(row['wallet'])),
      chainId: Number(row['chain_id']),
      message: text(row['message']),
      issuedAt: instant(row['issued_at']),
      expiresAt: instant(row['expires_at']),
    };
  }

  async createSession(fingerprint: string, session: StoredSession): Promise<void> {
    await this.#db.query(
      `INSERT INTO auth_sessions (token_fingerprint, wallet, chain_id, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [fingerprint, session.wallet, session.chainId, iso(session.issuedAt), iso(session.expiresAt)],
    );
  }

  async readSession(fingerprint: string, at: UtcTimestamp): Promise<StoredSession | null> {
    // Live is both conditions, checked in the query rather than after it: a row
    // read and then judged in JavaScript is a row that could have been revoked
    // in between.
    const { rows } = await this.#db.query(
      `SELECT wallet, chain_id, issued_at, expires_at
         FROM auth_sessions
        WHERE token_fingerprint = $1
          AND revoked_at IS NULL
          AND expires_at > $2`,
      [fingerprint, iso(at)],
    );

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      wallet: walletAddress(text(row['wallet'])),
      chainId: Number(row['chain_id']),
      issuedAt: instant(row['issued_at']),
      expiresAt: instant(row['expires_at']),
    };
  }

  async revokeSession(fingerprint: string, at: UtcTimestamp): Promise<void> {
    // `revoked_at IS NULL` keeps the first revocation's timestamp. Revoking
    // twice is not an error — a second tab signing out is the ordinary case —
    // but the moment a session stopped working is a fact, and the later call
    // knows less about it than the earlier one did.
    await this.#db.query(
      `UPDATE auth_sessions
          SET revoked_at = $2
        WHERE token_fingerprint = $1
          AND revoked_at IS NULL`,
      [fingerprint, iso(at)],
    );
  }

  /**
   * Ends every live session a wallet holds (§45.2 revocation).
   *
   * Not part of the port, because nothing in the sign-in flow needs it — this
   * is the operator's tool for a wallet that has done something alarming, and
   * the runbook is what calls it.
   */
  async revokeEverySession(wallet: string, at: UtcTimestamp): Promise<number> {
    const { rows } = await this.#db.query(
      `UPDATE auth_sessions
          SET revoked_at = $2
        WHERE wallet = $1
          AND revoked_at IS NULL
          AND expires_at > $2
        RETURNING token_fingerprint`,
      [walletAddress(wallet), iso(at)],
    );
    return rows.length;
  }

  async pruneExpired(at: UtcTimestamp): Promise<number> {
    // Deleted rather than archived. An expired challenge is refused by every
    // read already, and a revoked session's row says nothing an audit needs
    // that the actions taken with it do not say better.
    const challenges = await this.#db.query(
      'DELETE FROM auth_challenges WHERE expires_at <= $1 RETURNING nonce',
      [iso(at)],
    );
    const sessions = await this.#db.query(
      'DELETE FROM auth_sessions WHERE expires_at <= $1 RETURNING token_fingerprint',
      [iso(at)],
    );
    return challenges.rows.length + sessions.rows.length;
  }
}

function iso(at: UtcTimestamp): string {
  return new Date(at).toISOString();
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a text column, got ${typeof value}`);
  }
  return value;
}

function instant(value: unknown): UtcTimestamp {
  return utcTimestamp(value instanceof Date ? value.getTime() : new Date(String(value)).getTime());
}
