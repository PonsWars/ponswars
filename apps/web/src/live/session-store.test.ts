import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearStoredSession, readStoredSession, storeSession } from './session-store.js';

/**
 * Where a token lives between page loads (§45.2).
 *
 * Half of these are about storage that is not there or does not work. A private
 * window, a browser configured to block site data, a full quota — each one
 * throws rather than returning `null`, and a client that cannot start because
 * somebody browses privately would be a worse failure than losing a session.
 */

const SESSION = {
  token: 'a'.repeat(43),
  wallet: `0x${'b'.repeat(40)}`,
  expiresAt: 1_800_003_600_000,
};

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
    key: () => null,
    length: 0,
  };
}

/** A browser that refuses storage entirely, the way a locked-down one does. */
function refusingStorage(): Storage {
  const refuse = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
    key: refuse,
    length: 0,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a stored session', () => {
  it('survives a round trip', () => {
    vi.stubGlobal('localStorage', memoryStorage());

    storeSession(SESSION);

    expect(readStoredSession()).toEqual(SESSION);
  });

  it('is gone after signing out', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    storeSession(SESSION);

    clearStoredSession();

    expect(readStoredSession()).toBeNull();
  });

  it('is nothing when there is nothing', () => {
    vi.stubGlobal('localStorage', memoryStorage());

    expect(readStoredSession()).toBeNull();
  });
});

describe('storage that will not cooperate', () => {
  it('reads as no session rather than throwing', () => {
    vi.stubGlobal('localStorage', refusingStorage());

    expect(readStoredSession()).toBeNull();
  });

  it('writes without throwing, and simply does not persist', () => {
    // Out of quota, or storage disabled. The session still works for this page;
    // it will not survive a reload, and that is better than refusing to sign in.
    vi.stubGlobal('localStorage', refusingStorage());

    expect(() => {
      storeSession(SESSION);
    }).not.toThrow();
  });

  it('clears without throwing', () => {
    vi.stubGlobal('localStorage', refusingStorage());

    expect(() => {
      clearStoredSession();
    }).not.toThrow();
  });
});

describe('a value this client did not write', () => {
  it('is not a session', () => {
    // Another script on the origin, or an older build with a different shape.
    const storage = memoryStorage();
    storage.setItem('ponswars.session', '{"token":42}');
    vi.stubGlobal('localStorage', storage);

    expect(readStoredSession()).toBeNull();
  });

  it('is not a session when it is not even JSON', () => {
    const storage = memoryStorage();
    storage.setItem('ponswars.session', 'not json at all');
    vi.stubGlobal('localStorage', storage);

    expect(readStoredSession()).toBeNull();
  });
});
