import type { Session } from './auth-client.js';

/**
 * Where a session token lives between page loads (§45.2).
 *
 * `localStorage`, and the tradeoff is worth stating rather than assuming. A
 * token here survives a reload and a new tab, which is what a player expects
 * after signing a message — but it is also readable by any script that runs on
 * this origin. Two things make that an acceptable trade rather than a careless
 * one:
 *
 *   - the deployed client sets a `Content-Security-Policy` with `script-src
 *     'self'` and no `unsafe-inline`, so "any script that runs on this origin"
 *     is a much smaller set than it sounds;
 *   - the session rotates, so the token sitting here is always young, and the
 *     server can revoke it (§45.2) the moment anything looks wrong.
 *
 * Every access is wrapped. Storage throws rather than returning `null` in a
 * private window in some browsers, and a client that cannot start because
 * somebody browses privately would be a worse failure than losing a session.
 */

const KEY = 'ponswars.session';

export function readStoredSession(): Session | null {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { token, wallet, expiresAt } = parsed as Record<string, unknown>;
    if (typeof token !== 'string' || typeof wallet !== 'string' || typeof expiresAt !== 'number') {
      return null;
    }
    return { token, wallet, expiresAt };
  } catch {
    // Something else wrote to this key, or an older build wrote a different
    // shape. Either way there is no session here, which is a state the client
    // already handles.
    return null;
  }
}

export function storeSession(session: Session): void {
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Out of quota, or storage disabled. The session still works for this page;
    // it simply will not survive a reload, and that is better than refusing to
    // sign in at all.
  }
}

export function clearStoredSession(): void {
  try {
    globalThis.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do, and nothing worth telling anyone.
  }
}
