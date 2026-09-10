import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSession,
  requestChallenge,
  rotateSession,
  signOut,
  verifySignature,
} from './auth-client.js';
import type { LiveEndpoints } from './endpoints.js';

/**
 * The sign-in conversation, from the browser's side (§69.4, §69.5).
 *
 * Every failure the server can answer with has a shape this client must be able
 * to show (§110.5), and the interesting assertions here are all about the
 * refusals — a success is one happy path and there are four ways to be told no.
 */

const ENDPOINTS: LiveEndpoints = {
  api: 'https://api.example.test',
  socket: 'wss://ws.example.test',
};

const CHALLENGE = {
  nonce: '0'.repeat(32),
  message: 'api.example.test wants you to sign in…',
  expiresAt: 1_800_000_300_000,
  statement: 'Sign in to PonsWars.',
  chainId: 8453,
};

const SESSION = {
  token: 'a'.repeat(43),
  wallet: `0x${'b'.repeat(40)}`,
  expiresAt: 1_800_003_600_000,
};

function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** The one request that was made, as the values this client actually sent. */
interface Sent {
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

function stub(response: Response | Error): () => Sent {
  const calls: Sent[] = [];
  const fetcher = (_url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  vi.stubGlobal('fetch', fetcher);
  return () => {
    const first = calls[0];
    if (first === undefined) {
      throw new Error('no request was made');
    }
    return first;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asking for something to sign', () => {
  it('sends the wallet and the chain, and reads the message back whole', async () => {
    // The message is never rebuilt on this side. Two implementations of
    // EIP-4361 is one too many, and a client that assembled its own would
    // produce a signature that recovers to nobody.
    const sent = stub(answer(201, CHALLENGE));

    const result = await requestChallenge(ENDPOINTS, SESSION.wallet, 8453);

    expect(result.ok && result.value.message).toBe(CHALLENGE.message);
    expect(sent().body).toEqual({ wallet: SESSION.wallet, chainId: 8453 });
  });

  it('carries the server’s own words for a refusal', async () => {
    // §110.5: the API already says what happened and what to do next.
    // Flattening that here would leave the UI with one shrug for every cause.
    stub(
      answer(400, {
        code: 'WRONG_CHAIN',
        message: 'This deployment accepts signatures from chain 8453 only.',
        stateIsSafe: true,
        nextStep: 'Switch your wallet to chain 8453 and connect again.',
        correlationId: 'req_test',
      }),
    );

    const result = await requestChallenge(ENDPOINTS, SESSION.wallet, 1);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure).toMatchObject({
      kind: 'REFUSED',
      code: 'WRONG_CHAIN',
      nextStep: 'Switch your wallet to chain 8453 and connect again.',
    });
  });

  it('says the server was unreachable rather than throwing', async () => {
    stub(new TypeError('Failed to fetch'));

    const result = await requestChallenge(ENDPOINTS, SESSION.wallet, 8453);

    expect(!result.ok && result.failure.kind).toBe('UNREACHABLE');
  });

  it('refuses an answer it cannot read', async () => {
    // A server speaking a shape this build does not understand is a version
    // mismatch, and saying so beats a TypeError three components later.
    stub(answer(201, { nonce: 'too-short' }));

    const result = await requestChallenge(ENDPOINTS, SESSION.wallet, 8453);

    expect(!result.ok && result.failure.kind).toBe('MALFORMED');
  });
});

describe('exchanging a signature', () => {
  it('sends the wallet, the nonce and the signature, and nothing else', async () => {
    // Notably not the message. The server holds the one it issued and verifies
    // against that; an echoed copy is either identical or a lie.
    const sent = stub(answer(201, SESSION));

    const result = await verifySignature(ENDPOINTS, {
      wallet: SESSION.wallet,
      nonce: CHALLENGE.nonce,
      signature: `0x${'c'.repeat(130)}`,
    });

    expect(result.ok && result.value.token).toBe(SESSION.token);
    expect(Object.keys(sent().body as object).sort()).toEqual(['nonce', 'signature', 'wallet']);
  });
});

describe('a token from storage', () => {
  it('is checked against the server before anyone is shown as signed in', async () => {
    const sent = stub(answer(200, { wallet: SESSION.wallet, expiresAt: SESSION.expiresAt }));

    const result = await fetchSession(ENDPOINTS, SESSION.token);

    expect(result.ok && result.value.wallet).toBe(SESSION.wallet);
    expect(sent().headers).toMatchObject({ authorization: `Bearer ${SESSION.token}` });
  });

  it('comes back refused when it has expired or been revoked', async () => {
    stub(
      answer(401, {
        code: 'UNAUTHENTICATED',
        message: 'This action needs a connected wallet.',
        stateIsSafe: true,
        nextStep: 'Connect a wallet and try again. Watching needs no wallet.',
        correlationId: 'req_test',
      }),
    );

    const result = await fetchSession(ENDPOINTS, SESSION.token);

    expect(!result.ok && result.failure.kind).toBe('REFUSED');
  });
});

describe('rotation and signing out', () => {
  it('rotates into a different token', async () => {
    stub(answer(201, { ...SESSION, token: 'd'.repeat(43) }));

    const result = await rotateSession(ENDPOINTS, SESSION.token);

    expect(result.ok && result.value.token).not.toBe(SESSION.token);
  });

  it('signs out without complaining when the network is gone', async () => {
    // The local copy is dropped by the caller whatever this answers: a
    // sign-out that failed at the server is still a sign-out on this device.
    stub(new TypeError('Failed to fetch'));

    await expect(signOut(ENDPOINTS, SESSION.token)).resolves.toBeUndefined();
  });
});
