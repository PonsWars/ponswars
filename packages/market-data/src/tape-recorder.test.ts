import type { NormalizedActivity } from '@ponswars/pons-indexer';
import {
  utcTimestamp,
  walletAddress,
  type ActiveTicker,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { PRICE_SCALE, type DexTrade, type ReferencePrice } from './dex-price.js';
import type { Span } from './dex-window.js';
import { TapeSource, type TapeEntry } from './market-tape.js';
import type { MarketSource } from './onchain-market.js';
import { TapeRecorder } from './tape-recorder.js';

const T0 = Date.parse('2026-09-16T14:00:00Z');
const DOLLAR = 1_000_000n;
const all = { from: utcTimestamp(0), to: utcTimestamp(Number.MAX_SAFE_INTEGER) };

/** A source whose contents a test changes between snapshots. */
class LiveSource implements MarketSource {
  dex: DexTrade[] = [];
  pons: NormalizedActivity[] = [];
  ref: ReferencePrice | null = null;
  covered: UtcTimestamp = utcTimestamp(0);
  trades(ticker: ActiveTicker, span: Span): readonly DexTrade[] {
    return ticker === 'NVDA' ? this.dex.filter((t) => t.at >= span.from && t.at < span.to) : [];
  }
  notional(): bigint {
    return 0n;
  }
  ponsActivity(ticker: ActiveTicker, span: Span): readonly NormalizedActivity[] {
    return this.pons.filter((p) => p.ticker === ticker && p.at >= span.from && p.at < span.to);
  }
  reference(ticker: ActiveTicker): ReferencePrice | null {
    return ticker === 'NVDA' ? this.ref : null;
  }
  units(): { quoteDecimals: number; tokenDecimals: number } {
    return { quoteDecimals: 6, tokenDecimals: 18 };
  }
  coversUntil(): UtcTimestamp {
    return this.covered;
  }
}

const trade = (id: string, at: number): DexTrade => ({
  eventId: id,
  poolId: '0xpool',
  blockNumber: 1,
  at: utcTimestamp(at),
  quoteAmount: 10n * DOLLAR,
  tokenAmount: 10n ** 17n,
});

describe('TapeRecorder', () => {
  it('writes each trade once across overlapping reads, and closes every read with a mark', () => {
    const source = new LiveSource();
    let wall = T0;
    const recorder = new TapeRecorder(source, () => wall);
    const tape: TapeEntry[] = [...recorder.header(4663)];

    source.ref = { price: 200n * PRICE_SCALE, updatedAt: utcTimestamp(T0 - 60_000) };
    source.dex = [trade('0xa:1', T0 - 2_000)];
    source.covered = utcTimestamp(T0 - 1_000);
    tape.push(...recorder.snapshot());

    // The next read still holds the first trade, and a second dated just before
    // where the last read stopped.
    wall = T0 + 1_000;
    source.dex = [trade('0xa:1', T0 - 2_000), trade('0xb:1', T0 - 1_500)];
    source.pons = [
      {
        eventId: '0xp:1',
        wallet: walletAddress('0x00000000000000000000000000000000000000aa'),
        ticker: 'NVDA',
        amount: 30n * DOLLAR,
        blockNumber: 2,
        at: utcTimestamp(T0),
      },
    ];
    source.covered = utcTimestamp(T0);
    const second = recorder.snapshot();
    tape.push(...second);

    expect(second.map((entry) => entry.kind)).toEqual(['TRADE', 'PONS', 'COVERED']);
    expect(tape.filter((entry) => entry.kind === 'REFERENCE')).toHaveLength(1);
    expect(tape.filter((entry) => entry.kind === 'UNITS')).toHaveLength(10);

    // What was written replays as what was read.
    const replay = new TapeSource(tape, DOLLAR, 'wall');
    replay.seeUntil(wall);
    expect(replay.trades('NVDA', all).map((entry) => entry.eventId)).toEqual(['0xa:1', '0xb:1']);
    expect(replay.ponsActivity('NVDA', all)).toEqual(source.pons);
    expect(replay.reference('NVDA')).toEqual(source.ref);
    expect(replay.coversUntil()).toBe(T0);
  });

  it('writes a reference again only when it changes', () => {
    const source = new LiveSource();
    const recorder = new TapeRecorder(source, () => T0);
    source.ref = { price: 1n, updatedAt: utcTimestamp(T0) };
    recorder.snapshot();

    expect(recorder.snapshot().some((entry) => entry.kind === 'REFERENCE')).toBe(false);
    source.ref = { price: 2n, updatedAt: utcTimestamp(T0 + 1) };
    expect(recorder.snapshot().filter((entry) => entry.kind === 'REFERENCE')).toHaveLength(1);
  });
});
