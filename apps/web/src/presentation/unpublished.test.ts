import { describe, expect, it } from 'vitest';
import { unpublishedCopy, type PersonalPage } from './unpublished.js';

const PAGES: readonly PersonalPage[] = ['PROFILE', 'REWARDS', 'GENESIS'];

describe('a personal page with nothing published', () => {
  it('asks a visitor with no wallet to connect one, on every page', () => {
    for (const page of PAGES) {
      const copy = unpublishedCopy(page, false);
      expect(copy.headline).toMatch(/^CONNECT /);
      expect(copy.body).toMatch(/bar above/);
    }
  });

  it('tells a connected wallet the data is not published, rather than asking it to connect again', () => {
    for (const page of PAGES) {
      const copy = unpublishedCopy(page, true);
      expect(copy.headline).not.toMatch(/CONNECT/);
      expect(copy.headline).toMatch(/NOT PUBLISHED YET$/);
    }
  });

  it('never claims anything about the wallet it cannot know', () => {
    // The copy this replaced said "no Genesis claim on this wallet" — a
    // statement of fact about a wallet no service had been asked about.
    for (const page of PAGES) {
      for (const connected of [false, true]) {
        const { headline, body } = unpublishedCopy(page, connected);
        const text = `${headline} ${body}`;
        expect(text).not.toMatch(/\d/);
        expect(text).not.toMatch(/\bNO GENESIS CLAIM\b|\bqualified\b/i);
      }
    }
  });

  it('says something different on every page', () => {
    const headlines = PAGES.flatMap((page) => [
      unpublishedCopy(page, false).headline,
      unpublishedCopy(page, true).headline,
    ]);
    expect(new Set(headlines).size).toBe(headlines.length);
  });
});
