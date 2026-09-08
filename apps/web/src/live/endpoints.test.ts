import { describe, expect, it } from 'vitest';
import { liveEndpoints, type BuildEnvironment } from './endpoints.js';

/**
 * What an unconfigured build is allowed to do.
 *
 * The answer is: say so. Every case below exists because the alternative — a
 * compiled-in localhost address, or half a configuration — fails somewhere far
 * away from the mistake.
 */

const env = (values: BuildEnvironment): BuildEnvironment => values;

describe('reading the endpoints', () => {
  it('accepts a configured pair', () => {
    expect(
      liveEndpoints(
        env({ VITE_API_URL: 'https://api.example.test', VITE_WS_URL: 'wss://ws.example.test' }),
      ),
    ).toEqual({ api: 'https://api.example.test', socket: 'wss://ws.example.test' });
  });

  it('trims a trailing slash so paths do not double up', () => {
    // `${api}/v1/rounds/current` against a trailing slash produces `//v1/...`,
    // which some servers route and some reject.
    expect(
      liveEndpoints(
        env({ VITE_API_URL: 'http://localhost:4000/', VITE_WS_URL: 'ws://localhost:4001' }),
      )?.api,
    ).toBe('http://localhost:4000');
  });

  it('returns null when nothing was configured', () => {
    expect(liveEndpoints(env({}))).toBeNull();
  });

  it('returns null for half a configuration', () => {
    // The dangerous case: an API with no socket fetches a round and then never
    // moves it, which looks like a stalled battle rather than a missing setting.
    expect(liveEndpoints(env({ VITE_API_URL: 'https://api.example.test' }))).toBeNull();
    expect(liveEndpoints(env({ VITE_WS_URL: 'wss://ws.example.test' }))).toBeNull();
  });

  it('refuses a value that is not a URL', () => {
    expect(
      liveEndpoints(
        env({ VITE_API_URL: 'api.example.test', VITE_WS_URL: 'wss://ws.example.test' }),
      ),
    ).toBeNull();
  });

  it('refuses a scheme it cannot speak', () => {
    // An http URL in the socket slot is the likely typo, and it would fail at
    // the moment a player opens the world rather than at build time.
    expect(
      liveEndpoints(
        env({ VITE_API_URL: 'https://api.example.test', VITE_WS_URL: 'https://ws.example.test' }),
      ),
    ).toBeNull();
    expect(
      liveEndpoints(
        env({ VITE_API_URL: 'ws://api.example.test', VITE_WS_URL: 'wss://ws.example.test' }),
      ),
    ).toBeNull();
  });

  it('treats an empty string as unset', () => {
    // A CI environment that defines the variable without a value is not a
    // configuration, and an empty origin would build the URL `/v1/rounds/current`
    // against whatever host happened to serve the page.
    expect(
      liveEndpoints(env({ VITE_API_URL: '  ', VITE_WS_URL: 'wss://ws.example.test' })),
    ).toBeNull();
  });
});
