import {
  utcTimestamp,
  walletAddress,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { challengeMessage } from './message.js';
import { generateNonce, generateSessionToken, tokenFingerprint } from './nonce.js';
import type { AuthStore } from './ports.js';
import { verifySignedChallenge, type VerificationFailure } from './verify.js';

/**
 * Wallet sign-in, end to end (§45.2, §68.2).
 *
 * Ask for a challenge, sign it, exchange it for a session, use the session
 * until it expires. §45.2 is explicit that a player is *not* asked to sign
 * again for every ten-minute action — a wallet prompt before each pick would
 * train people to sign without reading, which is the habit every drainer
 * depends on.
 *
 * The transport is elsewhere. This knows nothing about HTTP, headers or status
 * codes: it takes an address and returns a message, takes a signature and
 * returns a session. That is what lets the whole flow be exercised without a
 * server.
 */

export interface AuthPolicy {
  /**
   * How long a challenge is worth signing (§45.2 expiry).
   *
   * `OPEN` (§102): §45.2 says short-lived and names no figure, so a deployment
   * says. It bounds the window in which a stolen-but-unsigned challenge is
   * worth anything, and has to be long enough for a hardware wallet.
   */
  readonly challengeTtlMs: number;
  /**
   * How long a session lasts before the wallet is asked again.
   *
   * `OPEN` (§102) for the same reason, and the more consequential of the two: a
   * session is a bearer credential, so this is how long a stolen one works.
   */
  readonly sessionTtlMs: number;
  /** Origin asking for the signature — host and port, no scheme. */
  readonly domain: string;
  /** The same origin with its scheme, for the message's `URI` field. */
  readonly uri: string;
  /** The chain a signature must name (§45.2: "chain matches policy"). */
  readonly chainId: number;
}

export interface Challenge {
  readonly nonce: string;
  readonly message: string;
  readonly expiresAt: UtcTimestamp;
}

export interface Session {
  /** Handed to the client once. The store keeps only its fingerprint. */
  readonly token: string;
  readonly wallet: WalletAddress;
  readonly expiresAt: UtcTimestamp;
}

export type VerifyRejection = VerificationFailure | 'NO_SUCH_CHALLENGE';

export type SignInResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: VerifyRejection };

export interface AuthServiceOptions {
  readonly store: AuthStore;
  readonly policy: AuthPolicy;
  readonly now: () => UtcTimestamp;
}

export class AuthService {
  readonly #store: AuthStore;
  readonly #policy: AuthPolicy;
  readonly #now: () => UtcTimestamp;

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#now = options.now;
  }

  /** The chain this deployment accepts signatures for. */
  get chainId(): number {
    return this.#policy.chainId;
  }

  /**
   * Issues a challenge for an address (§69.4).
   *
   * Issued for whatever address is asked for, without checking that it exists
   * or has ever played: an unknown address is exactly what a first sign-in
   * looks like, and refusing here would leak which wallets have accounts.
   */
  async challenge(address: string): Promise<Challenge> {
    const wallet = walletAddress(address);
    const issuedAt = this.#now();
    const expiresAt = utcTimestamp(issuedAt + this.#policy.challengeTtlMs);
    const nonce = generateNonce();

    const message = challengeMessage({
      domain: this.#policy.domain,
      uri: this.#policy.uri,
      address: wallet,
      chainId: this.#policy.chainId,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });

    await this.#store.saveChallenge({
      nonce,
      wallet,
      chainId: this.#policy.chainId,
      message,
      issuedAt,
      expiresAt,
    });

    return { nonce, message, expiresAt };
  }

  /**
   * Exchanges a signature for a session (§69.5).
   *
   * The challenge is consumed before the signature is checked, and stays
   * consumed whether or not it verifies. §45.2 makes the nonce single-use, and
   * "single-use unless the signature was wrong" is not single-use — it would
   * leave a nonce an attacker can keep trying against.
   */
  async verify(nonce: string, signature: string): Promise<SignInResult> {
    const at = this.#now();
    const challenge = await this.#store.consumeChallenge(nonce, at);
    if (challenge === null) {
      return { ok: false, reason: 'NO_SUCH_CHALLENGE' };
    }

    const verified = await verifySignedChallenge({
      message: challenge.message,
      signature,
      expectedWallet: challenge.wallet,
      expectedDomain: this.#policy.domain,
      expectedChainId: challenge.chainId,
      at: new Date(at),
    });
    if (!verified.ok) {
      return { ok: false, reason: verified.reason };
    }

    return { ok: true, session: await this.#issue(verified.wallet, challenge.chainId, at) };
  }

  /** The wallet behind a session token, or `null` if it is not a live one. */
  async walletOf(token: string): Promise<WalletAddress | null> {
    const session = await this.#store.readSession(tokenFingerprint(token), this.#now());
    return session?.wallet ?? null;
  }

  /** The whole session, for a client asking what it is signed in as. */
  async session(token: string): Promise<{ wallet: WalletAddress; expiresAt: UtcTimestamp } | null> {
    const session = await this.#store.readSession(tokenFingerprint(token), this.#now());
    return session === null ? null : { wallet: session.wallet, expiresAt: session.expiresAt };
  }

  /**
   * Signing out, and the revocation §45.2 asks for.
   *
   * Idempotent, and deliberately says nothing about whether the token was live:
   * a caller who can ask this question already holds the token, and an answer
   * would only help someone who does not.
   */
  async revoke(token: string): Promise<void> {
    await this.#store.revokeSession(tokenFingerprint(token), this.#now());
  }

  /**
   * Rotates a live session (§45.2 session rotation).
   *
   * A new token with a fresh expiry, and the old one revoked in the same
   * breath. This is how a long visit stays signed in without the session token
   * itself being long-lived — the credential in flight is always young.
   */
  async rotate(token: string): Promise<Session | null> {
    const at = this.#now();
    const fingerprint = tokenFingerprint(token);
    const current = await this.#store.readSession(fingerprint, at);
    if (current === null) {
      return null;
    }
    const next = await this.#issue(current.wallet, current.chainId, at);
    // After the new one exists. A crash between the two leaves a session that
    // still works, which is recoverable; the other order leaves a client with
    // no session and no way to get one without signing again.
    await this.#store.revokeSession(fingerprint, at);
    return next;
  }

  /** Housekeeping. §45.2 has nothing to say about it; the tables do. */
  prune(): Promise<number> {
    return this.#store.pruneExpired(this.#now());
  }

  async #issue(wallet: WalletAddress, chainId: number, at: UtcTimestamp): Promise<Session> {
    const token = generateSessionToken();
    const expiresAt = utcTimestamp(at + this.#policy.sessionTtlMs);
    await this.#store.createSession(tokenFingerprint(token), {
      wallet,
      chainId,
      issuedAt: at,
      expiresAt,
    });
    return { token, wallet, expiresAt };
  }
}
