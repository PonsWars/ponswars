import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';

/**
 * What authentication needs from storage, and nothing more (§45.2).
 *
 * Two records with one property each that matters. A challenge may be consumed
 * exactly once; a session may be read until it expires or is revoked. Both of
 * those are the store's job rather than this package's, because "exactly once"
 * across several server processes is a database constraint and cannot be
 * anything else — a check-then-write in application code is a race, and the
 * race is the attack.
 */

export interface StoredChallenge {
  readonly nonce: string;
  readonly wallet: WalletAddress;
  readonly chainId: number;
  /** The exact message the wallet was asked to sign. */
  readonly message: string;
  readonly issuedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

export interface StoredSession {
  readonly wallet: WalletAddress;
  readonly chainId: number;
  readonly issuedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

export interface AuthStore {
  /** Records a challenge that has been issued but not yet answered. */
  saveChallenge(challenge: StoredChallenge): Promise<void>;

  /**
   * Takes a challenge, and takes it away.
   *
   * Returns `null` when there is no unused challenge under that nonce — used
   * already, never issued, or expired. Must be atomic: two requests arriving
   * with the same nonce is the replay this exists to stop, and only one of them
   * may be answered.
   */
  consumeChallenge(nonce: string, at: UtcTimestamp): Promise<StoredChallenge | null>;

  /**
   * Records an issued session under the fingerprint of its token.
   *
   * The token itself never reaches the store — see `tokenFingerprint`.
   */
  createSession(fingerprint: string, session: StoredSession): Promise<void>;

  /** The session behind a fingerprint, or `null` if expired, revoked or absent. */
  readSession(fingerprint: string, at: UtcTimestamp): Promise<StoredSession | null>;

  /**
   * Ends a session now.
   *
   * Idempotent: revoking a session that is already gone is a success, because
   * the caller's intent — that this token stops working — is satisfied.
   */
  revokeSession(fingerprint: string, at: UtcTimestamp): Promise<void>;

  /**
   * Drops expired challenges and sessions.
   *
   * Housekeeping rather than security: an expired row is already refused by
   * every read. Called periodically so the tables do not grow without bound.
   */
  pruneExpired(at: UtcTimestamp): Promise<number>;
}
