import type { UtcTimestamp } from '@ponswars/shared-types';
import type { AuthStore, StoredChallenge, StoredSession } from './ports.js';

/**
 * An `AuthStore` in memory, for development and for tests.
 *
 * Single-use is enforced by deleting before returning, which is atomic here
 * because JavaScript gives it that for free — one thread, no await between the
 * read and the delete. That is precisely why this is not a production store: a
 * second process has its own Map, so the same nonce would be consumable once in
 * each. The PostgreSQL adapter does it with a conditional `UPDATE`, which is
 * atomic for a reason rather than by accident.
 *
 * Sessions die with the process, so a restart signs everyone out. Acceptable
 * for a stack that says on startup it is development only; not acceptable
 * anywhere else.
 */
export class MemoryAuthStore implements AuthStore {
  readonly #challenges = new Map<string, StoredChallenge>();
  readonly #sessions = new Map<string, StoredSession>();

  saveChallenge(challenge: StoredChallenge): Promise<void> {
    this.#challenges.set(challenge.nonce, challenge);
    return Promise.resolve();
  }

  consumeChallenge(nonce: string, at: UtcTimestamp): Promise<StoredChallenge | null> {
    const challenge = this.#challenges.get(nonce);
    // Deleted whether or not it is still valid: an expired challenge is spent
    // as far as anyone is concerned, and leaving it would keep a nonce alive
    // for the length of the process.
    this.#challenges.delete(nonce);
    if (challenge === undefined || challenge.expiresAt <= at) {
      return Promise.resolve(null);
    }
    return Promise.resolve(challenge);
  }

  createSession(fingerprint: string, session: StoredSession): Promise<void> {
    this.#sessions.set(fingerprint, session);
    return Promise.resolve();
  }

  readSession(fingerprint: string, at: UtcTimestamp): Promise<StoredSession | null> {
    const session = this.#sessions.get(fingerprint);
    if (session === undefined || session.expiresAt <= at) {
      return Promise.resolve(null);
    }
    return Promise.resolve(session);
  }

  revokeSession(fingerprint: string): Promise<void> {
    this.#sessions.delete(fingerprint);
    return Promise.resolve();
  }

  pruneExpired(at: UtcTimestamp): Promise<number> {
    let removed = 0;
    for (const [nonce, challenge] of this.#challenges) {
      if (challenge.expiresAt <= at) {
        this.#challenges.delete(nonce);
        removed += 1;
      }
    }
    for (const [fingerprint, session] of this.#sessions) {
      if (session.expiresAt <= at) {
        this.#sessions.delete(fingerprint);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}
