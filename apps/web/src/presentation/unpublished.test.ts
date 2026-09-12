import { describe, expect, it } from 'vitest';
import {
  GENESIS_UNPUBLISHED,
  failureCopy,
  signedOutCopy,
  type PersonalPage,
} from './unpublished.js';

const PAGES: readonly PersonalPage[] = ['PROFILE', 'REWARDS', 'GENESIS'];

describe('a personal page with no wallet connected', () => {
  it('asks the visitor to connect one, on every page, differently', () => {
    const headlines = PAGES.map((page) => signedOutCopy(page).headline);

    for (const page of PAGES) {
      expect(signedOutCopy(page).headline).toMatch(/^CONNECT /);
      expect(signedOutCopy(page).body).toMatch(/bar above/);
    }
    expect(new Set(headlines).size).toBe(PAGES.length);
  });
});

describe('copy that describes a wallet no service has been asked about', () => {
  it('never claims a fact about it', () => {
    // The copy this replaced said "no Genesis claim on this wallet" — a
    // statement about a wallet nothing had looked up.
    const all = [...PAGES.map((page) => signedOutCopy(page)), GENESIS_UNPUBLISHED];
    for (const { headline, body } of all) {
      const text = `${headline} ${body}`;
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/\bNO GENESIS CLAIM\b|\bqualified\b/i);
    }
  });
});

describe('a record that did not load', () => {
  it('says the record is unchanged when the server could not be reached', () => {
    const copy = failureCopy({ kind: 'UNREACHABLE', detail: 'Failed to fetch' });

    expect(copy.body).toMatch(/Nothing about your record has changed/);
  });

  it('asks for a new sign-in when the session has ended, using the server’s next step', () => {
    const copy = failureCopy({
      kind: 'REFUSED',
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'This needs a signed-in wallet.',
      nextStep: 'Connect your wallet and sign in.',
    });

    expect(copy.headline).toBe('SIGN IN AGAIN TO SEE YOUR RECORD');
    expect(copy.body).toContain('Connect your wallet and sign in.');
  });

  it('passes on any other refusal in the server’s own words', () => {
    const copy = failureCopy({
      kind: 'REFUSED',
      status: 503,
      code: 'UNAVAILABLE',
      message: 'The record service is restarting.',
      nextStep: 'Try again in a minute.',
    });

    expect(copy.body).toBe('The record service is restarting. Try again in a minute.');
  });

  it('points an unreadable answer at the likeliest cause', () => {
    expect(failureCopy({ kind: 'MALFORMED', detail: 'x' }).body).toMatch(/Reload/);
  });
});
