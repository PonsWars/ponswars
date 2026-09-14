import { utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  comparableSpans,
  isMarketOpen,
  nextOpenAt,
  nextOpenWindow,
  parseHolidays,
  tradingDayOf,
} from './market-session.js';

/** A UTC instant from an ISO string. */
const at = (iso: string) => utcTimestamp(Date.parse(iso));
const OPEN_CALENDAR = { holidays: new Set<string>() };

describe('tradingDayOf', () => {
  it('starts a trading day at 20:00 New York, in summer and in winter', () => {
    // 2026-09-13 is a Sunday. EDT: 20:00 New York is 00:00 UTC.
    expect(tradingDayOf(at('2026-09-13T23:59:00Z')).date).toBe('2026-09-13');
    expect(tradingDayOf(at('2026-09-14T00:00:00Z')).date).toBe('2026-09-14');
    // 2026-12-06 is a Sunday. EST: 20:00 New York is 01:00 UTC.
    expect(tradingDayOf(at('2026-12-07T00:59:00Z')).date).toBe('2026-12-06');
    expect(tradingDayOf(at('2026-12-07T01:00:00Z')).date).toBe('2026-12-07');
  });
});

describe('isMarketOpen', () => {
  it('is open from Sunday 20:00 to Friday 20:00 New York', () => {
    expect(isMarketOpen(at('2026-09-13T23:30:00Z'), OPEN_CALENDAR)).toBe(false); // Sun 19:30
    expect(isMarketOpen(at('2026-09-14T00:30:00Z'), OPEN_CALENDAR)).toBe(true); // Sun 20:30
    expect(isMarketOpen(at('2026-09-16T14:00:00Z'), OPEN_CALENDAR)).toBe(true); // Wed 10:00
    expect(isMarketOpen(at('2026-09-18T23:30:00Z'), OPEN_CALENDAR)).toBe(true); // Fri 19:30
    expect(isMarketOpen(at('2026-09-19T00:30:00Z'), OPEN_CALENDAR)).toBe(false); // Fri 20:30
    expect(isMarketOpen(at('2026-09-19T15:00:00Z'), OPEN_CALENDAR)).toBe(false); // Sat
  });

  it('is shut for the whole of a holiday, including the overnight session before it', () => {
    // Thanksgiving, Thursday 2026-11-26 (EST).
    const calendar = { holidays: parseHolidays('2026-11-26') };
    expect(isMarketOpen(at('2026-11-26T00:30:00Z'), calendar)).toBe(true); // Wed 19:30
    expect(isMarketOpen(at('2026-11-26T01:30:00Z'), calendar)).toBe(false); // Wed 20:30
    expect(isMarketOpen(at('2026-11-26T18:00:00Z'), calendar)).toBe(false); // Thu 13:00
    expect(isMarketOpen(at('2026-11-27T01:30:00Z'), calendar)).toBe(true); // Thu 20:30
  });
});

describe('nextOpenAt', () => {
  it('is the instant itself while open', () => {
    const now = at('2026-09-16T14:00:00Z');
    expect(nextOpenAt(now, OPEN_CALENDAR)).toBe(now);
  });

  it('is Sunday 20:00 New York from a Saturday', () => {
    // Saturday 2026-09-19; the next session opens Sunday 2026-09-20 20:00 EDT.
    expect(nextOpenAt(at('2026-09-19T15:17:00Z'), OPEN_CALENDAR)).toBe(at('2026-09-21T00:00:00Z'));
  });

  it('skips a holiday Monday', () => {
    // Labor Day, Monday 2026-09-07: the market reopens Monday 20:00 New York.
    const calendar = { holidays: parseHolidays('2026-09-07') };
    expect(nextOpenAt(at('2026-09-05T12:00:00Z'), calendar)).toBe(at('2026-09-08T00:00:00Z'));
  });
});

describe('nextOpenWindow', () => {
  const TEN_MINUTES = 600_000;

  it('is now when a whole round fits before the close', () => {
    const now = at('2026-09-18T23:45:00Z'); // Fri 19:45 New York
    expect(nextOpenWindow(now, TEN_MINUTES, OPEN_CALENDAR)).toBe(now);
  });

  it('waits for the next session when a round would still be running at the close', () => {
    // Fri 19:55 New York: a ten-minute round would end after 20:00.
    expect(nextOpenWindow(at('2026-09-18T23:55:00Z'), TEN_MINUTES, OPEN_CALENDAR)).toBe(
      at('2026-09-21T00:00:00Z'),
    );
  });

  it('is the reopening itself from a closed market', () => {
    expect(nextOpenWindow(at('2026-09-19T15:00:00Z'), TEN_MINUTES, OPEN_CALENDAR)).toBe(
      at('2026-09-21T00:00:00Z'),
    );
  });
});

describe('parseHolidays', () => {
  it('accepts a list and refuses anything that is not a real date', () => {
    expect([...parseHolidays(' 2026-12-25, 2027-01-01 ')]).toEqual(['2026-12-25', '2027-01-01']);
    expect(() => parseHolidays('2026-02-30')).toThrow(RangeError);
    expect(() => parseHolidays('12/25/2026')).toThrow(RangeError);
  });
});

describe('comparableSpans', () => {
  it('takes the same span on earlier trading days and skips the weekend', () => {
    // Monday 10:00 New York.
    const from = at('2026-09-14T14:00:00Z');
    const span = { from, to: utcTimestamp(from + 540_000) };
    const earlier = comparableSpans(span, 2, OPEN_CALENDAR);
    expect(earlier.map((entry) => new Date(entry.from).toISOString())).toEqual([
      '2026-09-11T14:00:00.000Z',
      '2026-09-10T14:00:00.000Z',
    ]);
    expect(earlier[0]?.to).toBe(utcTimestamp(Date.parse('2026-09-11T14:09:00Z')));
  });
});
