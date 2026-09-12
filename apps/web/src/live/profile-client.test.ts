import { describe, expect, it } from 'vitest';
import { fetchProfile } from './profile-client.js';

/**
 * Reading a profile, and every way that can go wrong.
 *
 * The body below is what `GET /v1/profile` answers for a wallet with one win and
 * one void, in the shape the server's contract test parses.
 */

const ENDPOINTS = { api: 'https://api.test', socket: 'wss://ws.test' };

const PROFILE = {
  wallet: '0x00000000000000000000000000000000000000aa',
  lifetime: {
    battles: 1,
    wins: 1,
    losses: 0,
    winRateBps: 10_000,
    upsets: 1,
    majorUpsets: 0,
    cardAssistedWins: 1,
    warPoints: 14,
  },
  currentWindow: { warPoints: 14, qualified: false, weight: '3741657386', window: null },
  history: [
    {
      roundId: 'round-0000000002',
      battleId: 'round-0000000002-b0',
      left: 'NVDA',
      right: 'TSLA',
      backed: 'TSLA',
      outcome: 'UPSET_VICTORY',
      warPoints: 14,
      cardDeployed: true,
      settledAt: 1_800_001_200_000,
    },
    {
      roundId: 'round-0000000001',
      battleId: 'round-0000000001-b3',
      left: 'AMD',
      right: 'META',
      backed: 'AMD',
      outcome: 'VOID',
      warPoints: 0,
      cardDeployed: false,
      settledAt: 1_800_000_600_000,
    },
  ],
  mostBacked: { ticker: 'TSLA', battles: 1, winRateBps: 10_000 },
  biggestUpset: {
    roundId: 'round-0000000002',
    winner: 'TSLA',
    loser: 'NVDA',
    outcome: 'UPSET_VICTORY',
  },
  holdings: { status: 'UNPUBLISHED' },
};

const answer =
  (status: number, body: unknown): typeof fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('fetchProfile', () => {
  it('reads a profile with the session it was given', async () => {
    let seen: RequestInit | undefined;
    let url = '';
    const result = await fetchProfile(ENDPOINTS, 'Bearer abc', undefined, (input, init) => {
      url = input instanceof Request ? input.url : input.toString();
      seen = init;
      return Promise.resolve(new Response(JSON.stringify(PROFILE), { status: 200 }));
    });

    expect(url).toBe('https://api.test/v1/profile');
    expect(new Headers(seen?.headers).get('authorization')).toBe('Bearer abc');
    expect(result).toEqual({ ok: true, profile: PROFILE });
  });

  it('names a lapsed session rather than showing an empty record', async () => {
    const result = await fetchProfile(
      ENDPOINTS,
      'Bearer stale',
      undefined,
      answer(401, {
        code: 'UNAUTHENTICATED',
        message: 'This needs a signed-in wallet.',
        stateIsSafe: true,
        nextStep: 'Connect your wallet and sign in.',
        correlationId: 'req_1',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'REFUSED', status: 401, code: 'UNAUTHENTICATED' },
    });
  });

  it('refuses a body that is not the contract', async () => {
    const result = await fetchProfile(
      ENDPOINTS,
      'Bearer abc',
      undefined,
      answer(200, { ...PROFILE, estimatedPayout: '12.5' }),
    );

    expect(result).toMatchObject({ ok: false, failure: { kind: 'MALFORMED' } });
  });

  it('reports an unreachable server as unreachable', async () => {
    const result = await fetchProfile(ENDPOINTS, 'Bearer abc', undefined, () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );

    expect(result).toMatchObject({ ok: false, failure: { kind: 'UNREACHABLE' } });
  });
});
