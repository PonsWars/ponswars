import { utcTimestamp, walletAddress, type UtcTimestamp } from '@ponswars/shared-types';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuthStore } from './memory.js';
import { CHALLENGE_STATEMENT } from './message.js';
import { AuthService, type AuthPolicy } from './service.js';

/**
 * Wallet sign-in (§45.2, §69.4, §69.5).
 *
 * Signed by a real key with a real wallet implementation, because the one thing
 * these tests must not do is verify a signature this repository also produced
 * by the same code path. `viem`'s account signs the way a browser wallet signs;
 * everything below then goes through the same verification a request does.
 */

// A well-known test key. It signs nothing that exists and holds nothing.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);
const WALLET = walletAddress(account.address);

const POLICY: AuthPolicy = {
  challengeTtlMs: 300_000,
  sessionTtlMs: 3_600_000,
  domain: 'ponswars.test',
  uri: 'https://ponswars.test',
  chainId: 1,
};

let clock = 1_800_000_000_000;
const now = (): UtcTimestamp => utcTimestamp(clock);

let store: MemoryAuthStore;
let auth: AuthService;

beforeEach(() => {
  clock = 1_800_000_000_000;
  store = new MemoryAuthStore();
  auth = new AuthService({ store, policy: POLICY, now });
});

async function signIn(): Promise<{ nonce: string; message: string; signature: string }> {
  const challenge = await auth.challenge(WALLET);
  const signature = await account.signMessage({ message: challenge.message });
  return { nonce: challenge.nonce, message: challenge.message, signature };
}

describe('the challenge', () => {
  it('says what the signature is for, in the wallet', async () => {
    // §110: the one moment to tell somebody a signature is not a transaction is
    // the moment they are being asked for one.
    const challenge = await auth.challenge(WALLET);

    expect(parseSiweMessage(challenge.message).statement).toBe(CHALLENGE_STATEMENT);
    expect(CHALLENGE_STATEMENT).toContain('not a transaction');
  });

  it('names the domain, the chain and an expiry', async () => {
    const parsed = parseSiweMessage((await auth.challenge(WALLET)).message);

    expect(parsed.domain).toBe('ponswars.test');
    expect(parsed.chainId).toBe(1);
    expect(parsed.expirationTime).toEqual(new Date(clock + POLICY.challengeTtlMs));
  });

  it('never repeats a nonce', async () => {
    const nonces = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      nonces.add((await auth.challenge(WALLET)).nonce);
    }

    expect(nonces.size).toBe(50);
  });
});

describe('exchanging a signature for a session', () => {
  it('accepts a signature from the wallet it was issued to', async () => {
    const { nonce, signature } = await signIn();

    const result = await auth.verify(nonce, signature);

    expect(result.ok).toBe(true);
    expect(result.ok && result.session.wallet).toBe(WALLET);
  });

  it('refuses a second use of the same challenge', async () => {
    // §45.2: single-use. Signing once and replaying the same pair is the attack
    // this whole flow exists to stop.
    const { nonce, signature } = await signIn();
    await auth.verify(nonce, signature);

    const replayed = await auth.verify(nonce, signature);

    expect(replayed).toEqual({ ok: false, reason: 'NO_SUCH_CHALLENGE' });
  });

  it('spends the challenge even when the signature is wrong', async () => {
    // Otherwise a nonce survives every failed attempt, and an attacker who can
    // reach this endpoint gets unlimited attempts against one live challenge.
    const { nonce, message } = await signIn();
    const wrong = await privateKeyToAccount(`0x${'11'.repeat(32)}`).signMessage({ message });

    const first = await auth.verify(nonce, wrong);
    const second = await auth.verify(nonce, wrong);

    expect(first).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(second).toEqual({ ok: false, reason: 'NO_SUCH_CHALLENGE' });
  });

  it('refuses a signature from a different wallet', async () => {
    const { nonce, message } = await signIn();
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);

    const result = await auth.verify(nonce, await other.signMessage({ message }));

    expect(result).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('refuses a signature over a message the server did not issue', async () => {
    // The client never sends the message back — the server verifies against its
    // own copy — so a wallet shown something else produces a signature that
    // recovers to somebody who is not the challenge's wallet.
    const { nonce } = await signIn();
    const elsewhere = await account.signMessage({ message: 'Approve everything' });

    const result = await auth.verify(nonce, elsewhere);

    expect(result).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('refuses a challenge that expired while it was being signed', async () => {
    const { nonce, signature } = await signIn();
    clock += POLICY.challengeTtlMs + 1;

    const result = await auth.verify(nonce, signature);

    expect(result).toEqual({ ok: false, reason: 'NO_SUCH_CHALLENGE' });
  });

  it('refuses a nonce nobody issued', async () => {
    const { signature } = await signIn();

    const result = await auth.verify('0'.repeat(32), signature);

    expect(result).toEqual({ ok: false, reason: 'NO_SUCH_CHALLENGE' });
  });
});

describe('the session', () => {
  it('names the wallet that signed', async () => {
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    const token = result.ok ? result.session.token : '';

    expect(await auth.walletOf(token)).toBe(WALLET);
  });

  it('is not the token the store keeps', async () => {
    // A database read must not be a set of live sessions. The store holds a
    // fingerprint; the token itself exists only in the response and the client.
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    const token = result.ok ? result.session.token : '';

    expect(JSON.stringify(store)).not.toContain(token);
  });

  it('stops working when it expires', async () => {
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    const token = result.ok ? result.session.token : '';

    clock += POLICY.sessionTtlMs;

    expect(await auth.walletOf(token)).toBeNull();
  });

  it('stops working when it is revoked', async () => {
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    const token = result.ok ? result.session.token : '';

    await auth.revoke(token);

    expect(await auth.walletOf(token)).toBeNull();
  });

  it('can be revoked twice without complaint', async () => {
    // Sign out, then sign out again from a second tab. The caller's intent —
    // that this token stops working — is already satisfied.
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    const token = result.ok ? result.session.token : '';

    await auth.revoke(token);

    await expect(auth.revoke(token)).resolves.toBeUndefined();
  });

  it('rotates into a new token and retires the old one', async () => {
    const { nonce, signature } = await signIn();
    const result = await auth.verify(nonce, signature);
    const token = result.ok ? result.session.token : '';

    clock += 60_000;
    const rotated = await auth.rotate(token);

    expect(rotated?.token).not.toBe(token);
    expect(rotated?.wallet).toBe(WALLET);
    expect(rotated?.expiresAt).toBe(clock + POLICY.sessionTtlMs);
    expect(await auth.walletOf(token)).toBeNull();
    expect(await auth.walletOf(rotated?.token ?? '')).toBe(WALLET);
  });

  it('will not rotate a session that is already gone', async () => {
    expect(await auth.rotate('not-a-token')).toBeNull();
  });

  it('answers nothing for a token that was never issued', async () => {
    expect(await auth.walletOf('not-a-token')).toBeNull();
    expect(await auth.session('not-a-token')).toBeNull();
  });
});

describe('housekeeping', () => {
  it('drops what has expired and keeps what has not', async () => {
    const live = await signIn();
    const session = await auth.verify(live.nonce, live.signature);
    const token = session.ok ? session.session.token : '';
    await auth.challenge(WALLET);
    await auth.challenge(WALLET);

    clock += POLICY.challengeTtlMs + 1;

    expect(await auth.prune()).toBe(2);
    expect(await auth.walletOf(token)).toBe(WALLET);
  });
});
