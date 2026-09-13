import { describe, expect, it } from 'vitest';
import { fetchGenesis, requestGenesis } from './genesis-client.js';

const ENDPOINTS = { api: 'https://api.test', socket: 'wss://ws.test' };
const AUTH = 'Bearer token';

const CLAIM = {
  genesisId: '000042',
  requestId: 'genesis-0x00000000000000000000000000000000000000aa',
  wallet: '0x00000000000000000000000000000000000000aa',
  rarity: 'RARE',
  cardType: 'BULL_RUN',
  initialUses: 3,
  slot: 812_345,
  seed: 'ab'.repeat(32),
  entropyBlock: 62_000_010,
  entropyBlockHash: `0x${'cd'.repeat(32)}`,
  secretAvailable: false,
  rarityTableVersion: 'rarity-table-v1-secret-disabled',
  finalizedAt: 1_800_000_000_000,
};

function server(status: number, body: unknown) {
  const sent: { url: string; method: string | undefined; authorization: string | null }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
  return { fetchImpl, sent };
}

describe('the Genesis client', () => {
  it('reads the claim with the session, and hands back the card', async () => {
    const { fetchImpl, sent } = server(200, { status: 'READY', claim: CLAIM });

    const result = await fetchGenesis(ENDPOINTS, AUTH, undefined, fetchImpl);

    expect(result).toEqual({ ok: true, status: { status: 'READY', claim: CLAIM } });
    expect(sent).toEqual([
      { url: 'https://api.test/v1/genesis', method: 'GET', authorization: AUTH },
    ]);
  });

  it('asks for a card with a POST and no body', async () => {
    const { fetchImpl, sent } = server(200, {
      status: 'PENDING_FINALITY',
      requestId: CLAIM.requestId,
      targetBlock: 62_000_010,
    });

    const result = await requestGenesis(ENDPOINTS, AUTH, undefined, fetchImpl);

    expect(result.ok && result.status.status).toBe('PENDING_FINALITY');
    expect(sent[0]).toMatchObject({ url: 'https://api.test/v1/genesis/request', method: 'POST' });
  });

  it('names a chain that did not answer, rather than showing no claim', async () => {
    const { fetchImpl } = server(503, {
      code: 'CHAIN_UNAVAILABLE',
      message: 'Robinhood Chain did not answer in time, so nothing was decided.',
      stateIsSafe: true,
      nextStep: 'Try again in a moment.',
      correlationId: 'req_1',
    });

    const result = await requestGenesis(ENDPOINTS, AUTH, undefined, fetchImpl);

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'REFUSED', code: 'CHAIN_UNAVAILABLE' },
    });
  });

  it('refuses a card that is not the contract', async () => {
    const { fetchImpl } = server(200, { status: 'READY', claim: { ...CLAIM, cardType: 'NOPE' } });

    expect((await fetchGenesis(ENDPOINTS, AUTH, undefined, fetchImpl)).ok).toBe(false);
  });

  it('reports an unreachable server as unreachable', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;

    expect(await fetchGenesis(ENDPOINTS, AUTH, undefined, fetchImpl)).toMatchObject({
      ok: false,
      failure: { kind: 'UNREACHABLE' },
    });
  });
});
