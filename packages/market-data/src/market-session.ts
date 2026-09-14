import { utcTimestamp, type UtcTimestamp } from '@ponswars/shared-types';
import type { Span } from './dex-window.js';

/**
 * When the stock market the factions stand for is trading (§23.8).
 *
 * Robinhood's Stock Tokens follow US equities through all of their 24/5
 * sessions — overnight, pre-market, regular and post-market — which run from
 * Sunday 20:00 to Friday 20:00 New York time, and not at all on an exchange
 * holiday. Outside that the underlying price does not move, and §23.8 is plain
 * that a closed market *"must not be treated as ordinary flat price action"*:
 * a battle there would be decided by whatever the DEX pools drift to with no
 * market behind them. So no round opens while the market is closed.
 *
 * One rule covers every session boundary. Each session from 20:00 belongs to
 * the next calendar day's trading day, so a trading day is simply the New York
 * date four hours later — Sunday 20:00 becomes Monday, Friday 20:00 becomes
 * Saturday. The market is open when that trading day is a weekday that is not a
 * holiday.
 *
 * The holiday list is configuration, not code: it is published by the exchange
 * a year at a time, and a compiled list goes silently wrong the January after
 * nobody updated it (ADR 0002).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A New York calendar date, `YYYY-MM-DD`. */
export type TradingDate = string;

const NEW_YORK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

/** The trading day an instant belongs to, and whether that day is a weekday. */
export function tradingDayOf(at: UtcTimestamp): { date: TradingDate; weekday: boolean } {
  const parts = NEW_YORK.formatToParts(new Date(at + 4 * HOUR));
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  const weekday = part('weekday');
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: weekday !== 'Sat' && weekday !== 'Sun',
  };
}

/** Exchange holidays, as New York dates. */
export interface MarketCalendar {
  readonly holidays: ReadonlySet<TradingDate>;
}

/**
 * Parses a holiday list: comma-separated `YYYY-MM-DD` dates.
 *
 * @throws RangeError on anything that is not a real date in that form — a
 *   typo here would reopen the market on a day it is shut.
 */
export function parseHolidays(raw: string): ReadonlySet<TradingDate> {
  const dates = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const date of dates) {
    const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const check = parsed === null ? null : new Date(`${date}T12:00:00Z`);
    if (
      check === null ||
      Number.isNaN(check.getTime()) ||
      check.toISOString().slice(0, 10) !== date
    ) {
      throw new RangeError(`Not a holiday date: "${date}" (expected YYYY-MM-DD)`);
    }
  }
  return new Set(dates);
}

/** Whether the market is trading at an instant. */
export function isMarketOpen(at: UtcTimestamp, calendar: MarketCalendar): boolean {
  const day = tradingDayOf(at);
  return day.weekday && !calendar.holidays.has(day.date);
}

/**
 * The next instant at or after `at` when the market is open.
 *
 * Found by stepping to each following session boundary (20:00 New York is where
 * a trading day starts), so daylight-saving changes cannot skip one. Bounded:
 * a calendar that never reopens within sixty days is a configuration error,
 * not a long weekend.
 */
export function nextOpenAt(at: UtcTimestamp, calendar: MarketCalendar): UtcTimestamp {
  if (isMarketOpen(at, calendar)) {
    return at;
  }
  let probe: number = at;
  for (let step = 0; step < 60 * 24; step += 1) {
    // Whole hours: the boundary is on the hour in New York in every season.
    probe = Math.floor(probe / HOUR) * HOUR + HOUR;
    if (isMarketOpen(utcTimestamp(probe), calendar)) {
      return utcTimestamp(probe);
    }
  }
  throw new RangeError('The market calendar does not reopen within sixty days');
}

/**
 * The first instant at or after `at` from which the market stays open for
 * `durationMs` — when a whole round can run (§3.1, §23.8).
 *
 * Opening a round five minutes before Friday's close would only schedule a
 * battle to void when the market shuts under it. Sessions only begin and end
 * on the hour in New York, so checking each hour boundary a span crosses, and
 * its last instant, is enough to know it stays open.
 */
export function nextOpenWindow(
  at: UtcTimestamp,
  durationMs: number,
  calendar: MarketCalendar,
): UtcTimestamp {
  let start = nextOpenAt(at, calendar);
  for (let attempt = 0; attempt < 60 * 24; attempt += 1) {
    const end = start + durationMs - 1;
    let closesInside = !isMarketOpen(utcTimestamp(end), calendar);
    for (
      let hour = Math.floor(start / HOUR) * HOUR + HOUR;
      !closesInside && hour <= end;
      hour += HOUR
    ) {
      closesInside = !isMarketOpen(utcTimestamp(hour), calendar);
    }
    if (!closesInside) {
      return start;
    }
    // Past the closure, then to wherever the market next opens.
    start = nextOpenAt(utcTimestamp(Math.floor(end / HOUR) * HOUR + HOUR), calendar);
  }
  throw new RangeError('The market calendar has no window that long within sixty days');
}

/**
 * The same span on the `count` most recent earlier trading days (§12.2).
 *
 * What "normal volume for this stretch of the day" is measured against. Days
 * the market was shut are skipped, not counted as zero — a Monday compared with
 * the Sunday before it would always look like a surge.
 */
export function comparableSpans(span: Span, count: number, calendar: MarketCalendar): Span[] {
  const spans: Span[] = [];
  for (let back = 1; spans.length < count && back <= count * 4 + 14; back += 1) {
    const from = utcTimestamp(span.from - back * DAY);
    if (isMarketOpen(from, calendar)) {
      spans.push({ from, to: utcTimestamp(span.to - back * DAY) });
    }
  }
  return spans;
}
