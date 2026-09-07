import { describe, expect, it } from 'vitest';
import {
  FEED_HEALTH,
  FEED_KINDS,
  isScorable,
  requiresVoid,
  SCORABLE_FEED_HEALTH,
  VOID_REASON_CATEGORIES,
  type FeedHealth,
} from './feed.js';

describe('feed vocabulary', () => {
  it('declares the three scoring feeds', () => {
    // §23.1: price, volume and Pons each keep their own native cadence.
    expect([...FEED_KINDS]).toEqual(['PRICE', 'VOLUME', 'PONS']);
  });

  it('declares the four health states', () => {
    expect([...FEED_HEALTH]).toEqual(['HEALTHY', 'DEGRADED', 'STALE', 'UNAVAILABLE']);
  });

  it('orders health from best to worst', () => {
    // A UI or an alert can rely on this ordering rather than inventing one.
    expect(FEED_HEALTH.indexOf('HEALTHY')).toBeLessThan(FEED_HEALTH.indexOf('DEGRADED'));
    expect(FEED_HEALTH.indexOf('DEGRADED')).toBeLessThan(FEED_HEALTH.indexOf('STALE'));
    expect(FEED_HEALTH.indexOf('STALE')).toBeLessThan(FEED_HEALTH.indexOf('UNAVAILABLE'));
  });
});

describe('scorability', () => {
  it('scores from healthy and degraded data only', () => {
    // DEGRADED data is late but real. STALE and UNAVAILABLE are not data at
    // all, and continuing past them would mean inventing a result.
    expect([...SCORABLE_FEED_HEALTH]).toEqual(['HEALTHY', 'DEGRADED']);
    expect(isScorable('HEALTHY')).toBe(true);
    expect(isScorable('DEGRADED')).toBe(true);
    expect(isScorable('STALE')).toBe(false);
    expect(isScorable('UNAVAILABLE')).toBe(false);
  });

  it('voids exactly the states it cannot score from', () => {
    // §4.4 and Brief §6: never synthesize a result to keep the UI moving.
    for (const health of FEED_HEALTH) {
      expect(requiresVoid(health)).toBe(!isScorable(health));
    }
  });

  it.each(['STALE', 'UNAVAILABLE'] as const satisfies readonly FeedHealth[])(
    'voids a battle on %s',
    (health) => {
      expect(requiresVoid(health)).toBe(true);
    },
  );

  it('does not void on merely degraded data', () => {
    // Voiding on every hiccup would make the game unplayable; the threshold is
    // a real integrity failure, not latency.
    expect(requiresVoid('DEGRADED')).toBe(false);
  });
});

describe('void reasons', () => {
  it('keeps the public category set minimal and grounded', () => {
    // Both come from the masterplan: §4.4 integrity failure with the copy fixed
    // by §110.6, and the §23.8 halt that must not read as flat price action.
    // Adding a category changes what players are told.
    expect([...VOID_REASON_CATEGORIES]).toEqual(['DATA_INTEGRITY', 'MARKET_HALT']);
  });
});
