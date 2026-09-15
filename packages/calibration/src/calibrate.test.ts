import { PRICE_SCALE, type TapeEntry } from '@ponswars/market-data';
import { ACTIVE_TICKERS, utcTimestamp, type ActiveTicker } from '@ponswars/shared-types';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { calibrate, type CalibrationOptions, type CalibrationReport } from './calibrate.js';
import { parseCandidate } from './candidate.js';
import { suggest } from './suggest.js';

const candidate = parseCandidate(
  JSON.parse(
    readFileSync(
      new URL('../../../tools/calibration/initial-candidate.json', import.meta.url),
      'utf8',
    ),
  ),
);

/** Wednesday 2026-09-16 14:00 UTC, 10:00 in New York: the market is open. */
const START = Date.parse('2026-09-16T14:00:00Z');
const HOUR = 3_600_000;
const DOLLAR = 1_000_000n;

/**
 * An hour of market in which every ticker trades every ten seconds around $100,
 * each drifting its own way, except AMZN, which never trades at all.
 */
function hourOfMarket(): TapeEntry[] {
  const tape: TapeEntry[] = [
    { kind: 'START', version: 1, chainId: 4663, wallAt: START },
    ...ACTIVE_TICKERS.map((ticker): TapeEntry => ({
      kind: 'UNITS',
      ticker,
      quoteDecimals: 6,
      tokenDecimals: 18,
    })),
    ...ACTIVE_TICKERS.map((ticker): TapeEntry => ({
      kind: 'REFERENCE',
      ticker,
      price: 100n * PRICE_SCALE,
      updatedAt: utcTimestamp(START - HOUR),
      readAt: START,
    })),
  ];
  let sequence = 0;
  for (let at = START; at <= START + HOUR; at += 10_000) {
    ACTIVE_TICKERS.forEach((ticker: ActiveTicker, index) => {
      if (ticker === 'AMZN') {
        return;
      }
      sequence += 1;
      // A slow drift with a wobble, so returns and volatility are not zero.
      const step = (at - START) / 10_000;
      const cents = 10_000 + ((index - 4) * step) / 40 + ((step % 3) - 1) * 5;
      tape.push({
        kind: 'TRADE',
        ticker,
        eventId: `0x${sequence.toString(16)}:0`,
        poolId: '0xpool',
        blockNumber: sequence,
        at: utcTimestamp(at),
        quoteAmount: ((BigInt(Math.round(cents)) * DOLLAR) / 100n) * 10n,
        tokenAmount: 10n * 10n ** 18n,
      });
    });
    // Read a second after it happened.
    tape.push({ kind: 'COVERED', at: utcTimestamp(at), wallAt: at + 1_000 });
  }
  return tape;
}

/** A tick every ten seconds: enough to see every behaviour, cheap enough for a busy test run. */
const OPTIONS: CalibrationOptions = { tickMs: 10_000, excludedAddresses: [], sampleEveryTicks: 6 };

// Replaying an hour of ten tickers through forty-five battles a round is real
// work; under a full parallel test run it needs longer than the default.
describe('calibrate', { timeout: 60_000 }, () => {
  let report: CalibrationReport;
  beforeAll(async () => {
    report = await calibrate(hourOfMarket(), candidate, OPTIONS);
  }, 60_000);

  it('voids the battles of a ticker that never trades and finalizes the rest', () => {
    // 25 minutes of volatility lookback and a 2-minute window leave room for
    // the rounds at 14:30, 14:40 and 14:50.
    expect(report.rounds).toEqual({ played: 3, marketClosed: 0, withoutVolumeHistory: 3 });
    // Nine of the forty-five pairs a round include AMZN.
    expect(report.battles.voided).toBe(3 * 9);
    expect(report.battles.finalized).toBe(3 * 36);
    expect(report.tickers.AMZN.voidsCaused).toBe(3 * 9);
    expect(report.tickers.AMZN.battles).toEqual({ finalized: 0, voided: 27 });
    expect(report.tickers.NVDA.battles).toEqual({ finalized: 24, voided: 3 });
    expect(report.tickers.NVDA.ticks.STALE).toBe(0);
    expect(report.tickers.AMZN.ticks.HEALTHY).toBe(0);

    expect(report.battles.margin.count).toBe(3 * 36);
    expect(report.tickers.NVDA.inputs.returnBps.count).toBeGreaterThan(0);
    const labelled = Object.values(report.battles.victoryLabels).reduce((a, b) => a + b, 0);
    expect(labelled).toBe(report.battles.finalized);
  });

  it('plays no round while the market is shut', async () => {
    const saturday = Date.parse('2026-09-19T14:00:00Z');
    const tape = hourOfMarket().map((entry): TapeEntry => {
      switch (entry.kind) {
        case 'COVERED':
          return {
            ...entry,
            at: utcTimestamp(entry.at - START + saturday),
            wallAt: entry.wallAt - START + saturday,
          };
        case 'TRADE':
          return { ...entry, at: utcTimestamp(entry.at - START + saturday) };
        default:
          return entry;
      }
    });
    const closed = await calibrate(tape, candidate, OPTIONS);
    expect(closed.rounds).toMatchObject({ played: 0, marketClosed: 3 });
    expect(closed.battles.finalized + closed.battles.voided).toBe(0);
  });

  it('reads starting values off the report, and names what it could not', () => {
    const suggestion = suggest(report);

    expect(suggestion.missing).toEqual([]);
    expect(BigInt(suggestion.engine.victory.decisiveMargin)).toBeGreaterThanOrEqual(
      BigInt(suggestion.engine.victory.narrowMargin),
    );
    expect(BigInt(suggestion.confidence.priceTrend.strong)).toBeGreaterThanOrEqual(
      BigInt(suggestion.confidence.priceTrend.weak),
    );
  });
});
