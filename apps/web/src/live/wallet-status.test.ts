import { describe, expect, it } from 'vitest';
import { fromServer, fromWallet } from './wallet-status.js';

/**
 * What the bar says when signing in did not work (§110.5, §42.15).
 *
 * The wording is the product here: a player who cannot sign in reads one line,
 * and it has to say whether anything is at stake and what to do next.
 */

const refusal = (
  code: string,
  extra: Record<string, unknown> = {},
): Parameters<typeof fromServer>[0] => ({
  kind: 'REFUSED',
  status: 429,
  code,
  message: 'Too many sign-in requests from this network in a short time.',
  nextStep: 'Nothing was recorded. Try again at 2023-11-14T22:13:20.000Z.',
  ...extra,
});

describe('a refusal from the server', () => {
  it('counts a rate limit down instead of printing a timestamp at a player', () => {
    const status = fromServer(refusal('RATE_LIMITED', { retryAt: 1_700_000_000_000 }));

    expect(status).toEqual({
      kind: 'REFUSED',
      message: 'Too many sign-in requests from this network in a short time.',
      // §42.15: clarity first, and an ISO timestamp in a bar over a battlefield
      // is neither clear nor something to act on. The instant is carried
      // separately, for the button that stops working until it passes.
      nextStep: 'Too many sign-in attempts from this network. Watching needs no wallet.',
      retryAt: 1_700_000_000_000,
    });
    expect(status.kind === 'REFUSED' && status.nextStep).not.toContain('2023');
  });

  it('says watching needs no wallet, because at that moment it is the useful fact', () => {
    // §5: the whole world is watchable without signing in, so a sign-in a
    // player cannot complete right now is not a locked door.
    const status = fromServer(refusal('RATE_LIMITED', { retryAt: 1 }));

    expect(status.kind === 'REFUSED' && status.nextStep).toContain('Watching needs no wallet');
  });

  it('passes through the server’s own next step for anything else', () => {
    const status = fromServer(refusal('SIGN_IN_REFUSED'));

    expect(status.kind === 'REFUSED' && status.nextStep).toBe(
      'Nothing was recorded. Try again at 2023-11-14T22:13:20.000Z.',
    );
    expect(status.kind === 'REFUSED' && status.retryAt).toBeUndefined();
  });

  it('names no wait for a server that never answered', () => {
    // Nothing to count down: a dropped connection can be retried at once.
    const status = fromServer({ kind: 'UNREACHABLE', detail: 'Failed to fetch' });

    expect(status).toMatchObject({ kind: 'REFUSED', message: 'The server did not answer.' });
    expect(status.kind === 'REFUSED' && status.retryAt).toBeUndefined();
  });
});

describe('a refusal from the wallet', () => {
  it('treats changing your mind as no error at all', () => {
    expect(fromWallet({ kind: 'DECLINED' })).toEqual({ kind: 'DISCONNECTED' });
  });

  it('names the network rather than saying "switch networks"', () => {
    const status = fromWallet({ kind: 'WRONG_CHAIN', chainId: 1, expected: 4663 });

    expect(status.kind === 'REFUSED' && status.nextStep).toContain('Robinhood Chain');
  });
});
