import type { NormalizedActivity } from '@ponswars/pons-indexer';
import {
  isActiveTicker,
  utcTimestamp,
  walletAddress,
  type ActiveTicker,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import type { DexTrade, ReferencePrice, TradeUnits } from './dex-price.js';
import type { Span } from './dex-window.js';
import type { MarketSource } from './onchain-market.js';

/**
 * A recording of the market as the indexer saw it, and a source that replays it.
 *
 * Every `OPEN` bound on the market — how thin a price window may be, how far it
 * may sit from Chainlink, what counts as dust — has to be measured against the
 * real market before a battle is decided by it (§102). Measuring needs the raw
 * material rather than the readings: a reading is already a conclusion under
 * one set of bounds, and the point is to try others. So the tape holds what the
 * source held — trades, Pons activity, references — and `TapeSource` hands it
 * back to the same `OnchainMarket` that runs in production.
 *
 * Time is recorded twice, because the market is. `at` is when a trade happened
 * on chain; `wallAt` on a coverage mark is when the recorder had read up to it.
 * A replay at wall-clock instant `t` sees only what had been read by `t`, so a
 * source that fell behind on the day falls behind in the replay too, and the
 * lag bound is measured against the lag that actually happened.
 *
 * One entry per line, JSON, integers as decimal strings.
 */

export const TAPE_VERSION = 1;

export type TapeEntry =
  /** A recorder (re)started. What it read before this and after it are not one run. */
  | {
      readonly kind: 'START';
      readonly version: number;
      readonly chainId: number;
      readonly wallAt: number;
    }
  | ({ readonly kind: 'UNITS'; readonly ticker: ActiveTicker } & TradeUnits)
  /** Everything above this line, since the last mark, had been read by `wallAt`, up to `at`. */
  | { readonly kind: 'COVERED'; readonly at: UtcTimestamp; readonly wallAt: number }
  | ({ readonly kind: 'TRADE'; readonly ticker: ActiveTicker } & DexTrade)
  | ({ readonly kind: 'PONS'; readonly ticker: ActiveTicker } & Omit<
      NormalizedActivity,
      'ticker' | 'counterparty'
    >)
  | ({
      readonly kind: 'REFERENCE';
      readonly ticker: ActiveTicker;
      /** When the recorder read it. */
      readonly readAt: number;
    } & ReferencePrice);

/** One entry as one line. */
export function encodeTapeEntry(entry: TapeEntry): string {
  return JSON.stringify(entry, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * One line back into an entry.
 *
 * @throws Error naming what is wrong, for a line that is not a tape entry. A
 *   tape that half-parsed would calibrate against a market that never was.
 */
export function decodeTapeEntry(line: string): TapeEntry {
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('A tape entry must be an object');
  }
  const fields = raw as Record<string, unknown>;
  switch (fields['kind']) {
    case 'START':
      return {
        kind: 'START',
        version: integer(fields, 'version'),
        chainId: integer(fields, 'chainId'),
        wallAt: integer(fields, 'wallAt'),
      };
    case 'UNITS':
      return {
        kind: 'UNITS',
        ticker: ticker(fields),
        quoteDecimals: integer(fields, 'quoteDecimals'),
        tokenDecimals: integer(fields, 'tokenDecimals'),
      };
    case 'COVERED':
      return {
        kind: 'COVERED',
        at: utcTimestamp(integer(fields, 'at')),
        wallAt: integer(fields, 'wallAt'),
      };
    case 'TRADE':
      return {
        kind: 'TRADE',
        ticker: ticker(fields),
        eventId: text(fields, 'eventId'),
        poolId: text(fields, 'poolId'),
        blockNumber: integer(fields, 'blockNumber'),
        at: utcTimestamp(integer(fields, 'at')),
        quoteAmount: big(fields, 'quoteAmount'),
        tokenAmount: big(fields, 'tokenAmount'),
      };
    case 'PONS':
      return {
        kind: 'PONS',
        eventId: text(fields, 'eventId'),
        wallet: walletAddress(text(fields, 'wallet')),
        ticker: ticker(fields),
        amount: big(fields, 'amount'),
        blockNumber: integer(fields, 'blockNumber'),
        at: utcTimestamp(integer(fields, 'at')),
      };
    case 'REFERENCE':
      return {
        kind: 'REFERENCE',
        ticker: ticker(fields),
        price: big(fields, 'price'),
        updatedAt: utcTimestamp(integer(fields, 'updatedAt')),
        readAt: integer(fields, 'readAt'),
      };
    default:
      throw new Error(`Unknown tape entry kind ${JSON.stringify(fields['kind'])}`);
  }
}

function integer(fields: Record<string, unknown>, name: string): number {
  const value = fields[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Tape entry field ${name} must be an integer`);
  }
  return value;
}

function text(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tape entry field ${name} must be a non-empty string`);
  }
  return value;
}

function big(fields: Record<string, unknown>, name: string): bigint {
  const value = text(fields, name);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Tape entry field ${name} must be a decimal integer`);
  }
  return BigInt(value);
}

function ticker(fields: Record<string, unknown>): ActiveTicker {
  const value = text(fields, 'ticker');
  if (!isActiveTicker(value)) {
    throw new Error(`Tape entry names ${value}, which is not on the roster`);
  }
  return value;
}

const MINUTE = 60_000;

/**
 * Which instant a replay moves by.
 *
 * - `wall` shows the market as the recorder had read it by each instant, lag
 *   and all. It measures the whole pipeline, endpoint included — what a
 *   service reading through that endpoint would have scored.
 * - `chain` shows each trade from the moment it happened and treats the source
 *   as current throughout the tape. It measures the market alone, which is
 *   what the market's bounds are for; a recorder that fell behind on a
 *   throttled endpoint still yields a usable tape. A stretch the recorder
 *   never read shows as no trades, not as lag — so a replay asks
 *   {@link TapeSource.records} before reading a stretch at all.
 */
export type TapeClock = 'wall' | 'chain';

/**
 * The market on a tape, as it could be seen at one instant.
 *
 * Built once from a whole tape, then moved forward with `seeUntil`. Only
 * forward: a replay walks time the way the service did, and a source that
 * could be wound back would invite a calibration that peeked ahead.
 *
 * Entries are revealed a coverage mark at a time, as they were read. A trade
 * recorded twice — a recorder restarting re-reads what it last kept — counts
 * once, as it does on chain.
 */
export class TapeSource implements MarketSource {
  /** Entries in the order they become visible, each with the instant it does. */
  private readonly timeline: { readonly at: number; readonly entry: TapeEntry }[] = [];
  private next = 0;
  private readonly firstCovered: number | null = null;
  private readonly lastCovered: number | null = null;
  /** The stretches read without a break, on the replay's clock (see {@link records}). */
  private readonly runs: { readonly from: number; readonly to: number }[] = [];
  private covered = utcTimestamp(0);
  private readonly seen = new Set<string>();
  private readonly dexTrades = new Map<ActiveTicker, DexTrade[]>();
  private readonly minuteVolume = new Map<ActiveTicker, Map<number, bigint>>();
  private readonly pons = new Map<ActiveTicker, NormalizedActivity[]>();
  private readonly references = new Map<ActiveTicker, ReferencePrice>();
  private readonly unitsOf = new Map<ActiveTicker, TradeUnits>();

  /**
   * @param entries A tape, in the order it was written.
   * @param minTradeQuote Smallest trade counted into volume — a bound under
   *   calibration, so the replay's and not the recorder's.
   * @param clock Which instant the replay moves by; see {@link TapeClock}.
   */
  constructor(
    entries: Iterable<TapeEntry>,
    private readonly minTradeQuote: bigint,
    private readonly clock: TapeClock,
  ) {
    let pending: TapeEntry[] = [];
    let firstCovered: number | null = null;
    let lastCovered: number | null = null;
    let run: { from: number; to: number } | null = null;
    for (const entry of entries) {
      if (entry.kind === 'UNITS') {
        this.unitsOf.set(entry.ticker, {
          quoteDecimals: entry.quoteDecimals,
          tokenDecimals: entry.tokenDecimals,
        });
      } else if (entry.kind === 'START') {
        // Whatever was read but never marked covered is not known to be complete.
        pending = [];
        // And the recorder was not running: what happened between its last
        // mark and its next was never read (see `records`).
        if (run !== null) {
          this.runs.push(run);
        }
        run = null;
      } else if (entry.kind === 'COVERED') {
        const markAt = clock === 'wall' ? entry.wallAt : entry.at;
        firstCovered ??= markAt;
        lastCovered = Math.max(lastCovered ?? markAt, markAt);
        run =
          run === null
            ? { from: markAt, to: markAt }
            : { from: run.from, to: Math.max(run.to, markAt) };
        for (const read of [...pending, entry]) {
          this.timeline.push({
            at: clock === 'wall' ? entry.wallAt : chainInstant(read),
            entry: read,
          });
        }
        pending = [];
      } else {
        pending.push(entry);
      }
    }
    if (run !== null) {
      this.runs.push(run);
    }
    if (clock === 'chain') {
      // Stable: entries at one instant keep the order they were read in.
      this.timeline.sort((a, b) => a.at - b.at);
    }
    this.firstCovered = firstCovered;
    this.lastCovered = lastCovered;
  }

  /** The first and last instant the tape covers, on its clock, or `null` for an empty tape. */
  get span(): { readonly from: number; readonly to: number } | null {
    return this.firstCovered === null || this.lastCovered === null
      ? null
      : { from: this.firstCovered, to: this.lastCovered };
  }

  /**
   * Whether the recorder read the whole of `from`…`to` without a break, on the
   * replay's clock.
   *
   * Between two coverage marks of one run, the read in between took in every
   * block, however long it was. Across a restart it did not: the recorder was
   * not running, and what happened meanwhile is simply absent from the tape.
   * Replayed as if it were read, that absence is a market in which nothing
   * traded — every battle over it void, and the void rate a measurement of the
   * machine that ran the recorder rather than of the market. A week recorded
   * on a laptop was more than half such holes.
   *
   * Conservative about restarts: a recorder re-reads a little history when it
   * starts, and that is not counted, because the tape does not say how far
   * back it reached.
   */
  records(from: number, to: number): boolean {
    return this.runs.some((run) => run.from <= from && to <= run.to);
  }

  /** Reveals everything visible by `instant`, on the replay's clock. */
  seeUntil(instant: number): void {
    for (
      let item = this.timeline[this.next];
      item !== undefined && item.at <= instant;
      item = this.timeline[this.next]
    ) {
      this.next += 1;
      this.reveal(item.entry);
    }
    if (this.clock === 'chain' && this.lastCovered !== null) {
      // The source is taken as current wherever the tape reaches.
      const current = Math.min(instant, this.lastCovered);
      if (current > this.covered) {
        this.covered = utcTimestamp(current);
      }
    }
  }

  trades(ticker: ActiveTicker, span: Span): readonly DexTrade[] {
    return between(this.dexTrades.get(ticker) ?? [], span);
  }

  /** Whole minutes, the way the chain indexer keeps them. */
  notional(ticker: ActiveTicker, span: Span): bigint {
    const minutes = this.minuteVolume.get(ticker);
    if (minutes === undefined) {
      return 0n;
    }
    const first = Math.ceil(span.from / MINUTE);
    let total = 0n;
    for (const [minute, value] of minutes) {
      if (minute >= first && minute * MINUTE < span.to) {
        total += value;
      }
    }
    return total;
  }

  ponsActivity(ticker: ActiveTicker, span: Span): readonly NormalizedActivity[] {
    return between(this.pons.get(ticker) ?? [], span);
  }

  reference(ticker: ActiveTicker): ReferencePrice | null {
    return this.references.get(ticker) ?? null;
  }

  units(ticker: ActiveTicker): TradeUnits {
    const units = this.unitsOf.get(ticker);
    if (units === undefined) {
      throw new Error(`The tape records no units for ${ticker}`);
    }
    return units;
  }

  coversUntil(): UtcTimestamp {
    return this.covered;
  }

  private reveal(entry: TapeEntry): void {
    switch (entry.kind) {
      case 'COVERED':
        if (entry.at > this.covered) {
          this.covered = entry.at;
        }
        return;
      case 'REFERENCE':
        this.references.set(entry.ticker, { price: entry.price, updatedAt: entry.updatedAt });
        return;
      case 'TRADE': {
        if (this.seen.has(entry.eventId)) {
          return;
        }
        this.seen.add(entry.eventId);
        const { kind: _kind, ticker, ...trade } = entry;
        insertByTime(listFor(this.dexTrades, ticker), trade);
        if (trade.quoteAmount >= this.minTradeQuote) {
          let minutes = this.minuteVolume.get(ticker);
          if (minutes === undefined) {
            minutes = new Map();
            this.minuteVolume.set(ticker, minutes);
          }
          const minute = Math.floor(trade.at / MINUTE);
          minutes.set(minute, (minutes.get(minute) ?? 0n) + trade.quoteAmount);
        }
        return;
      }
      case 'PONS': {
        if (this.seen.has(entry.eventId)) {
          return;
        }
        this.seen.add(entry.eventId);
        const { kind: _kind, ...activity } = entry;
        insertByTime(listFor(this.pons, activity.ticker), activity);
        return;
      }
      case 'START':
      case 'UNITS':
        return;
    }
  }
}

/** When an entry happened on chain, as far as a lag-free source would have seen it. */
function chainInstant(entry: TapeEntry): number {
  switch (entry.kind) {
    case 'TRADE':
    case 'PONS':
    case 'COVERED':
      return entry.at;
    case 'REFERENCE':
      return entry.updatedAt;
    case 'START':
    case 'UNITS':
      return 0;
  }
}

function listFor<T>(lists: Map<ActiveTicker, T[]>, ticker: ActiveTicker): T[] {
  let list = lists.get(ticker);
  if (list === undefined) {
    list = [];
    lists.set(ticker, list);
  }
  return list;
}

function insertByTime<T extends { readonly at: UtcTimestamp }>(list: T[], entry: T): void {
  let index = list.length;
  while (index > 0 && (list[index - 1]?.at ?? 0) > entry.at) {
    index -= 1;
  }
  list.splice(index, 0, entry);
}

function between<T extends { readonly at: UtcTimestamp }>(list: readonly T[], span: Span): T[] {
  return list.slice(lowerBound(list, span.from), lowerBound(list, span.to));
}

function lowerBound(list: readonly { readonly at: UtcTimestamp }[], at: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((list[middle]?.at ?? Infinity) < at) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
