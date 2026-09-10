import { createHash, randomBytes } from 'node:crypto';

/**
 * Single-use values, and the one-way form the database keeps (§45.2).
 *
 * Two different things live here because they are the same mistake if either is
 * done casually: a nonce that can be guessed lets an attacker prepare a
 * challenge, and a session token stored as it was issued turns a database read
 * into a set of live sessions.
 */

/**
 * A challenge nonce.
 *
 * 16 bytes of `randomBytes`, hex — not `Math.random`, which is seeded from
 * something a process can share with another process. §45.2 makes the nonce
 * single-use; the store enforces that, and this makes guessing the next one
 * pointless rather than merely hard.
 */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * A session token, handed to the client once and never stored as issued.
 *
 * 32 bytes: this is a bearer credential, and its whole strength is its length.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database keeps instead of the token.
 *
 * SHA-256 with no salt and no work factor, deliberately: this is a 256-bit
 * random value rather than a password, so there is no dictionary to run and
 * nothing for a slow hash to protect against. What it does protect against is
 * the ordinary case — a leaked backup, a query in a log — where every row would
 * otherwise be a session someone can use.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
