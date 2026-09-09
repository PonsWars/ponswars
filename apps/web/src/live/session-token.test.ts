import { describe, expect, it } from 'vitest';
import { sessionAuthorization } from './session-token.js';

/**
 * What a client with no wallet is allowed to be.
 *
 * The answer is: a spectator. §5 makes that the normal case, so the absence of
 * a token has to be an ordinary value rather than an error — a client that
 * threw here would make watching the world an exceptional path.
 */

describe('the session header', () => {
  it('formats a bare token', () => {
    expect(sessionAuthorization({ VITE_DEV_SESSION_TOKEN: 'abc123' })).toBe('Bearer abc123');
  });

  it('does not double-prefix a token that already carries the scheme', () => {
    // The likely paste. Sending `Bearer Bearer abc123` would fail against a real
    // gateway in a way that reads as a rejected wallet rather than a typo.
    expect(sessionAuthorization({ VITE_DEV_SESSION_TOKEN: 'Bearer abc123' })).toBe('Bearer abc123');
    expect(sessionAuthorization({ VITE_DEV_SESSION_TOKEN: 'bearer abc123' })).toBe('bearer abc123');
  });

  it('reads no token as a spectator', () => {
    expect(sessionAuthorization({})).toBeNull();
    expect(sessionAuthorization({ VITE_DEV_SESSION_TOKEN: '' })).toBeNull();
    expect(sessionAuthorization({ VITE_DEV_SESSION_TOKEN: '   ' })).toBeNull();
  });
});
