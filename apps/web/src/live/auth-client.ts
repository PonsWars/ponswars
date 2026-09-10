import {
  apiErrorSchema,
  authChallengeSchema,
  authSessionInfoSchema,
  authSessionSchema,
} from '@ponswars/schemas';
import type { LiveEndpoints } from './endpoints.js';

/**
 * Signing in, from the browser's side (§45.2, §69.4, §69.5).
 *
 * Four requests and no state. The session this produces is held by
 * `useWalletSession`; what happens here is the conversation with the server and
 * nothing else, which is what lets the whole flow be exercised with a `fetch`
 * stub.
 *
 * Every failure comes back named, like the pick client's. §110.5 wants an error
 * that says what happened and what to do about it, and the API already answers
 * that way — flattening it here would leave one shrug for an expired challenge,
 * a wrong network and a dropped connection.
 */

export type AuthFailure =
  /** The request never completed. */
  | { readonly kind: 'UNREACHABLE'; readonly detail: string }
  | {
      readonly kind: 'REFUSED';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly nextStep: string;
    }
  | { readonly kind: 'MALFORMED'; readonly detail: string };

export type AuthResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: AuthFailure };

export interface Challenge {
  readonly nonce: string;
  /** The exact message to hand the wallet. Never rebuilt on this side. */
  readonly message: string;
  readonly expiresAt: number;
  readonly chainId: number;
}

export interface Session {
  readonly token: string;
  readonly wallet: string;
  readonly expiresAt: number;
}

/** Asks for something to sign (§69.4). */
export async function requestChallenge(
  endpoints: LiveEndpoints,
  wallet: string,
  chainId: number,
): Promise<AuthResult<Challenge>> {
  return post(endpoints, '/v1/auth/challenge', { wallet, chainId }, (body) => {
    const parsed = authChallengeSchema.parse(body);
    return {
      nonce: parsed.nonce,
      message: parsed.message,
      expiresAt: parsed.expiresAt,
      chainId: parsed.chainId,
    };
  });
}

/** Exchanges a signature for a session (§69.5). */
export async function verifySignature(
  endpoints: LiveEndpoints,
  input: { readonly wallet: string; readonly nonce: string; readonly signature: string },
): Promise<AuthResult<Session>> {
  return post(endpoints, '/v1/auth/verify', input, (body) => authSessionSchema.parse(body));
}

/**
 * What a stored token still is, if anything.
 *
 * Called on load. A token in storage is a claim, not a session: it may have
 * expired while the tab was closed, been revoked, or belong to a deployment
 * this build no longer talks to. Asking is the only way to know, and the answer
 * decides whether the HUD opens signed in or signed out.
 */
export async function fetchSession(
  endpoints: LiveEndpoints,
  token: string,
): Promise<AuthResult<{ readonly wallet: string; readonly expiresAt: number }>> {
  return request(endpoints, '/v1/auth/session', { method: 'GET', token }, (body) =>
    authSessionInfoSchema.parse(body),
  );
}

/**
 * Ends the session (§45.2 revocation).
 *
 * The local copy is dropped by the caller whatever this answers. A sign-out
 * that failed at the server is still a sign-out on this device, and leaving the
 * token in storage because the network was down would be the worst of both.
 */
export async function signOut(endpoints: LiveEndpoints, token: string): Promise<void> {
  try {
    await fetch(`${endpoints.api}/v1/auth/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // Deliberately silent. See above.
  }
}

/**
 * Trades a live session for a younger one (§45.2 session rotation).
 *
 * Called well before expiry rather than at it, so a player mid-round is never
 * signed out between backing a stock and the lock. A failure is not an error to
 * show: the session that exists still works until it does not.
 */
export async function rotateSession(
  endpoints: LiveEndpoints,
  token: string,
): Promise<AuthResult<Session>> {
  return request(endpoints, '/v1/auth/session/rotate', { method: 'POST', token }, (body) =>
    authSessionSchema.parse(body),
  );
}

async function post<T>(
  endpoints: LiveEndpoints,
  path: string,
  body: unknown,
  read: (value: unknown) => T,
): Promise<AuthResult<T>> {
  return request(endpoints, path, { method: 'POST', body }, read);
}

async function request<T>(
  endpoints: LiveEndpoints,
  path: string,
  options: { readonly method: string; readonly body?: unknown; readonly token?: string },
  read: (value: unknown) => T,
): Promise<AuthResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${endpoints.api}${path}`, {
      method: options.method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error: unknown) {
    return {
      ok: false,
      failure: { kind: 'UNREACHABLE', detail: error instanceof Error ? error.message : 'no route' },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    return {
      ok: false,
      failure: error.success
        ? {
            kind: 'REFUSED',
            status: response.status,
            code: error.data.code,
            message: error.data.message,
            nextStep: error.data.nextStep,
          }
        : { kind: 'MALFORMED', detail: `HTTP ${String(response.status)}` },
    };
  }

  try {
    return { ok: true, value: read(payload) };
  } catch (error: unknown) {
    // Parsed on the way in, not trusted. A server answering a shape this client
    // does not understand is a version mismatch, and saying so is more useful
    // than a `TypeError` three components later.
    return {
      ok: false,
      failure: {
        kind: 'MALFORMED',
        detail: error instanceof Error ? error.message : 'unreadable response',
      },
    };
  }
}
