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
 * The market on a tape, as it could be seen at one wall-clock instant.
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
  private readonly batches: { readonly wallAt: number; readonly entries: TapeEntry[] }[] = [];
  private next = 0;
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
   */
  constructor(
    entries: Iterable<TapeEntry>,
    private readonly minTradeQuote: bigint,
  ) {
    let pending: TapeEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === 'UNITS') {
        this.unitsOf.set(entry.ticker, {
          quoteDecimals: entry.quoteDecimals,
          tokenDecimals: entry.tokenDecimals,
        });
      } else if (entry.kind === 'START') {
        // Whatever was read but never marked covered is not known to be complete.
        pending = [];
      } else if (entry.kind === 'COVERED') {
        pending.push(entry);
        this.batches.push({ wallAt: entry.wallAt, entries: pending });
        pending = [];
      } else {
        pending.push(entry);
      }
    }
  }

  /** The wall-clock instant of the first and last coverage marks, or `null` for an empty tape. */
  get span(): { readonly from: number; readonly to: number } | null {
    const first = this.batches[0];
    const last = this.batches.at(-1);
    return first === undefined || last === undefined
      ? null
      : { from: first.wallAt, to: last.wallAt };
  }

  /** Reveals everything that had been read by wall-clock instant `wallAt`. */
  seeUntil(wallAt: number): void {
    for (
      let batch = this.batches[this.next];
      batch !== undefined && batch.wallAt <= wallAt;
      batch = this.batches[this.next]
    ) {
      this.next += 1;
      for (const entry of batch.entries) {
        this.reveal(entry);
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
