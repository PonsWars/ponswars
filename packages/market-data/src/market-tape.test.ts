import { utcTimestamp, walletAddress } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { PRICE_SCALE } from './dex-price.js';
import { decodeTapeEntry, encodeTapeEntry, TapeSource, type TapeEntry } from './market-tape.js';

const DOLLAR = 1_000_000n;
const T0 = Date.parse('2026-09-16T14:00:00Z');
const all = { from: utcTimestamp(0), to: utcTimestamp(Number.MAX_SAFE_INTEGER) };

const trade = (id: string, at: number, dollars: bigint): TapeEntry => ({
  kind: 'TRADE',
  ticker: 'NVDA',
  eventId: id,
  poolId: '0xpool',
  blockNumber: 1,
  at: utcTimestamp(at),
  quoteAmount: dollars * DOLLAR,
  tokenAmount: 10n ** 18n,
});

const covered = (at: number, wallAt: number): TapeEntry => ({
  kind: 'COVERED',
  at: utcTimestamp(at),
  wallAt,
});

describe('tape entries', () => {
  it('survive a line and back, integers included', () => {
    const entries: TapeEntry[] = [
      { kind: 'START', version: 1, chainId: 4663, wallAt: T0 },
      { kind: 'UNITS', ticker: 'NVDA', quoteDecimals: 6, tokenDecimals: 18 },
      trade('0xa:1', T0, 2n ** 70n),
      {
        kind: 'PONS',
        eventId: '0xb:2',
        wallet: walletAddress('0x00000000000000000000000000000000000000aa'),
        ticker: 'GME',
        amount: 25n * DOLLAR,
        blockNumber: 7,
        at: utcTimestamp(T0),
      },
      {
        kind: 'REFERENCE',
        ticker: 'SPY',
        price: 761n * PRICE_SCALE,
        updatedAt: utcTimestamp(T0 - 1_000),
        readAt: T0,
      },
      covered(T0, T0 + 500),
    ];
    for (const entry of entries) {
      expect(decodeTapeEntry(encodeTapeEntry(entry))).toEqual(entry);
    }
  });

  it('refuse a line that is not one, rather than half-reading it', () => {
    expect(() => decodeTapeEntry('{"kind":"TRADE","ticker":"NVDA"}')).toThrow('eventId');
    expect(() =>
      decodeTapeEntry('{"kind":"UNITS","ticker":"COIN","quoteDecimals":6,"tokenDecimals":18}'),
    ).toThrow('not on the roster');
    expect(() =>
      decodeTapeEntry(encodeTapeEntry(trade('0xa:1', T0, 1n)).replace('"1000000"', '"1e6"')),
    ).toThrow('decimal integer');
    expect(() => decodeTapeEntry('{"kind":"GUESS"}')).toThrow('Unknown tape entry kind');
  });
});

describe('TapeSource', () => {
  it('on the chain clock, shows each trade from when it happened, however late it was read', () => {
    const tape: TapeEntry[] = [
      { kind: 'UNITS', ticker: 'NVDA', quoteDecimals: 6, tokenDecimals: 18 },
      trade('0xa:1', T0, 10n),
      trade('0xb:1', T0 + 30_000, 20n),
      // Read two minutes after the fact, by a recorder that fell behind.
      covered(T0 + 60_000, T0 + 180_000),
    ];

    const wall = new TapeSource(tape, DOLLAR, 'wall');
    wall.seeUntil(T0 + 45_000);
    expect(wall.trades('NVDA', all)).toEqual([]);

    const chain = new TapeSource(tape, DOLLAR, 'chain');
    chain.seeUntil(T0 + 45_000);
    expect(chain.trades('NVDA', all).map((entry) => entry.eventId)).toEqual(['0xa:1', '0xb:1']);
    expect(chain.coversUntil()).toBe(T0 + 45_000);
    expect(chain.span).toEqual({ from: T0 + 60_000, to: T0 + 60_000 });

    // Not past where the tape reaches.
    chain.seeUntil(T0 + 600_000);
    expect(chain.coversUntil()).toBe(T0 + 60_000);
  });

  it('shows only what had been read by the instant, and how far it reached', () => {
    const source = new TapeSource(
      [
        { kind: 'UNITS', ticker: 'NVDA', quoteDecimals: 6, tokenDecimals: 18 },
        trade('0xa:1', T0, 10n),
        covered(T0 + 1_000, T0 + 3_000),
        trade('0xb:1', T0 + 2_000, 20n),
        covered(T0 + 2_000, T0 + 4_000),
        // Read, but the recorder stopped before marking it covered.
        trade('0xc:1', T0 + 3_000, 30n),
      ],
      DOLLAR,
      'wall',
    );

    source.seeUntil(T0 + 2_999);
    expect(source.trades('NVDA', all)).toEqual([]);
    expect(source.coversUntil()).toBe(0);

    source.seeUntil(T0 + 3_000);
    expect(source.trades('NVDA', all).map((entry) => entry.eventId)).toEqual(['0xa:1']);
    expect(source.coversUntil()).toBe(T0 + 1_000);

    source.seeUntil(T0 + 60_000);
    expect(source.trades('NVDA', all).map((entry) => entry.eventId)).toEqual(['0xa:1', '0xb:1']);
    expect(source.units('NVDA')).toEqual({ quoteDecimals: 6, tokenDecimals: 18 });
    expect(source.span).toEqual({ from: T0 + 3_000, to: T0 + 4_000 });
  });

  it('counts a trade a restarted recorder read twice once, and drops what a crash left unmarked', () => {
    const source = new TapeSource(
      [
        trade('0xa:1', T0, 10n),
        trade('0xlost:1', T0, 99n),
        { kind: 'START', version: 1, chainId: 4663, wallAt: T0 + 5_000 },
        trade('0xa:1', T0, 10n),
        covered(T0 + 1_000, T0 + 6_000),
      ],
      DOLLAR,
      'wall',
    );
    source.seeUntil(T0 + 6_000);

    expect(source.trades('NVDA', all).map((entry) => entry.eventId)).toEqual(['0xa:1']);
    expect(source.notional('NVDA', all)).toBe(10n * DOLLAR);
  });

  it('says a stretch was recorded only when one run of the recorder read all of it', () => {
    const source = new TapeSource(
      [
        covered(T0, T0 + 1_000),
        // One read can take in minutes of chain at once; the run is unbroken.
        covered(T0 + 8 * 60_000, T0 + 8 * 60_000 + 1_000),
        // Stopped, and started again an hour later: nothing between was read.
        { kind: 'START', version: 1, chainId: 4663, wallAt: T0 + 68 * 60_000 },
        covered(T0 + 68 * 60_000, T0 + 68 * 60_000 + 1_000),
        covered(T0 + 70 * 60_000, T0 + 70 * 60_000 + 1_000),
      ],
      DOLLAR,
      'chain',
    );

    expect(source.records(T0, T0 + 8 * 60_000)).toBe(true);
    expect(source.records(T0 + 68 * 60_000, T0 + 70 * 60_000)).toBe(true);
    // Across the restart, and past either end.
    expect(source.records(T0 + 5 * 60_000, T0 + 69 * 60_000)).toBe(false);
    expect(source.records(T0 + 30 * 60_000, T0 + 40 * 60_000)).toBe(false);
    expect(source.records(T0 - 1, T0 + 60_000)).toBe(false);
    expect(source.records(T0 + 69 * 60_000, T0 + 71 * 60_000)).toBe(false);
  });

  it('counts volume by whole minutes, above the minimum it is given', () => {
    const source = new TapeSource(
      [
        trade('0xa:1', T0 + 5_000, 50n),
        trade('0xb:1', T0 + 65_000, 3n),
        trade('0xc:1', T0 + 70_000, 40n),
        covered(T0 + 120_000, T0 + 120_000),
      ],
      5n * DOLLAR,
      'wall',
    );
    source.seeUntil(T0 + 120_000);

    expect(source.notional('NVDA', all)).toBe(90n * DOLLAR);
    // The span starting mid-minute counts from the next whole minute.
    expect(
      source.notional('NVDA', { from: utcTimestamp(T0 + 1), to: utcTimestamp(T0 + 120_000) }),
    ).toBe(40n * DOLLAR);
  });

  it('keeps the latest reference it was given', () => {
    const source = new TapeSource(
      [
        { kind: 'REFERENCE', ticker: 'NVDA', price: 1n, updatedAt: utcTimestamp(T0), readAt: T0 },
        {
          kind: 'REFERENCE',
          ticker: 'NVDA',
          price: 2n,
          updatedAt: utcTimestamp(T0 + 1),
          readAt: T0 + 1,
        },
        covered(T0, T0),
      ],
      DOLLAR,
      'wall',
    );
    expect(source.reference('NVDA')).toBeNull();
    source.seeUntil(T0);
    expect(source.reference('NVDA')).toEqual({ price: 2n, updatedAt: T0 + 1 });
  });
});
