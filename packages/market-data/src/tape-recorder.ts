import { ACTIVE_TICKERS, utcTimestamp, type ActiveTicker } from '@ponswars/shared-types';
import { TAPE_VERSION, type TapeEntry } from './market-tape.js';
import type { MarketSource } from './onchain-market.js';

/**
 * Turns a live market source into tape entries, a read at a time.
 *
 * The recorder does not follow the chain itself; whatever does — the indexer's
 * poll loop — calls `snapshot` after each read, and gets back what is new since
 * the last one, closed by a coverage mark. Keeping it apart from the chain is
 * what lets it be tested over an array, and lets the same recorder sit behind
 * any source.
 *
 * "New" is judged by event id over a trailing overlap rather than by time
 * alone. A trade dated by interpolation can land a second before where the last
 * read stopped, and a trade missed at a boundary is a hole in the calibration
 * nobody would see.
 */

/** How far behind the last coverage mark each snapshot looks again. */
const OVERLAP_MS = 5 * 60_000;

export class TapeRecorder {
  private lastCovered = 0;
  /** Event ids already written, with when they happened, forgotten past the overlap. */
  private readonly written = new Map<string, number>();
  private readonly lastReference = new Map<ActiveTicker, string>();

  constructor(
    private readonly source: MarketSource,
    private readonly now: () => number,
  ) {}

  /** What a tape starts with, and what a restart writes again. */
  header(chainId: number): TapeEntry[] {
    return [
      { kind: 'START', version: TAPE_VERSION, chainId, wallAt: this.now() },
      ...ACTIVE_TICKERS.map((ticker): TapeEntry => ({
        kind: 'UNITS',
        ticker,
        ...this.source.units(ticker),
      })),
    ];
  }

  /**
   * Everything the source holds that has not been written, then a coverage mark.
   *
   * Nothing is marked covered that the source has not read: the mark carries
   * the source's own `coversUntil`, and the wall-clock instant it was taken.
   */
  snapshot(): TapeEntry[] {
    const covered = this.source.coversUntil();
    const span = {
      from: utcTimestamp(Math.max(0, this.lastCovered - OVERLAP_MS)),
      to: utcTimestamp(Number.MAX_SAFE_INTEGER),
    };
    const entries: TapeEntry[] = [];
    for (const ticker of ACTIVE_TICKERS) {
      const reference = this.source.reference(ticker);
      if (reference !== null) {
        const key = `${reference.price.toString()}@${String(reference.updatedAt)}`;
        if (this.lastReference.get(ticker) !== key) {
          this.lastReference.set(ticker, key);
          entries.push({ kind: 'REFERENCE', ticker, ...reference, readAt: this.now() });
        }
      }
      for (const trade of this.source.trades(ticker, span)) {
        if (this.remember(trade.eventId, trade.at)) {
          entries.push({ kind: 'TRADE', ticker, ...trade });
        }
      }
      for (const activity of this.source.ponsActivity(ticker, span)) {
        if (this.remember(activity.eventId, activity.at)) {
          entries.push({
            kind: 'PONS',
            eventId: activity.eventId,
            wallet: activity.wallet,
            ticker,
            amount: activity.amount,
            blockNumber: activity.blockNumber,
            at: activity.at,
          });
        }
      }
    }
    entries.push({ kind: 'COVERED', at: covered, wallAt: this.now() });

    this.lastCovered = Math.max(this.lastCovered, covered);
    const forgetBefore = this.lastCovered - 2 * OVERLAP_MS;
    for (const [eventId, at] of this.written) {
      if (at < forgetBefore) {
        this.written.delete(eventId);
      }
    }
    return entries;
  }

  /** Whether an event is new, noting it if so. */
  private remember(eventId: string, at: number): boolean {
    if (this.written.has(eventId)) {
      return false;
    }
    this.written.set(eventId, at);
    return true;
  }
}
