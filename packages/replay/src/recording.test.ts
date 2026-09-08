import { CURRENT_ENGINE_VERSIONS, type EngineConfig } from '@ponswars/battle-engine';
import { RATIO_SCALE } from '@ponswars/battle-math';
import { buildCanonicalClock, milliseconds, utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { decodeRecording, encodeRecording, type RoundRecording } from './recording.js';

/**
 * The recording codec.
 *
 * Fidelity of a *replayed round* is asserted in `simulations`, where the market
 * fixture lives. What is tested here is narrower and easier to get wrong: that a
 * recording survives a file, and that a damaged one is refused before the engine
 * ever sees it.
 */

const OPEN_AT = utcTimestamp(1_800_000_000_000);

const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 20n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

const RECORDING = {
  roundId: 'r-1',
  roundIndex: 0,
  clock: buildCanonicalClock(OPEN_AT, OPEN_AT),
  baseSeedHex: `0x${'5c'.repeat(32)}`,
  recentRounds: [],
  confidence: {
    lookback: {
      NVDA: {
        windowReturn: 250_000n,
        volatility: 1_000_000n,
        relativeVolume: 1_100_000n,
        qualifiedPonsActivity: 30n,
        subWindowReturns: [10n, -20n, 30n],
      },
    },
    calibration: {
      priceTrend: { strong: 500_000n, weak: -500_000n },
      volumePulse: { rising: 1_300_000n, weak: 700_000n },
      ponsActivity: { high: 40n, medium: 15n },
      momentumStability: { stable: 2, mixed: 5 },
      matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
    },
  },
  picks: [],
  tickLogs: [],
  finalizationBlockHash: `0x${'e1'.repeat(32)}`,
  config: CONFIG,
} as unknown as RoundRecording;

describe('the codec', () => {
  it('round-trips a recording unchanged', () => {
    expect(decodeRecording(encodeRecording(RECORDING))).toEqual(RECORDING);
  });

  it('keeps bigints as bigints', () => {
    // The scoring divisors are scaled integers (ADR 0003). One that came back
    // as a string would replay to a different score with nothing looking wrong,
    // which is the quietest possible way for §26's promise to become false.
    const decoded = decodeRecording(encodeRecording(RECORDING));
    expect(typeof decoded.config.scoring.priceEdgeDivisor).toBe('bigint');
    expect(decoded.config.scoring.priceEdgeDivisor).toBe(CONFIG.scoring.priceEdgeDivisor);
    expect(decoded.config.momentum.push).toBe(CONFIG.momentum.push);

    // Including the ones nested inside the confidence lookback and its array of
    // sub-window returns (§10.1). A recording whose lookback came back as
    // strings would replay to different labels, and §11 prices an upset from
    // those labels.
    const lookback = decoded.confidence.lookback['NVDA'];
    expect(lookback?.windowReturn).toBe(250_000n);
    expect(lookback?.subWindowReturns).toEqual([10n, -20n, 30n]);
  });

  it('does not confuse a plain object for an encoded bigint', () => {
    // The encoding marks a bigint with a `$bigint` string. An ordinary object
    // that happens to have that key with a non-string value must pass through
    // rather than be coerced.
    // The object has the marker key, which is what makes it a near miss: only
    // the value's type separates it from a real encoded bigint. The previous
    // version of this test passed an object with no marker at all, so it never
    // reached the branch it describes.
    const encoded = encodeRecording(RECORDING).replace(
      '"roundId":"r-1"',
      '"roundId":"r-1","decoy":{"$bigint":42}',
    );
    const decoded = decodeRecording(encoded) as RoundRecording & { decoy: unknown };

    expect(decoded.decoy).toEqual({ $bigint: 42 });
    expect(decoded.roundId).toBe('r-1');
  });
});

/**
 * Damages an encoded recording the way a real one would be damaged.
 *
 * Encoded first, then edited: a plain `JSON.stringify` of the recording cannot
 * serialise its bigints at all, so damaging the object directly would test a
 * file shape that could never arrive.
 */
function damaged(mutate: (draft: Record<string, unknown>) => Record<string, unknown>): string {
  const draft = JSON.parse(encodeRecording(RECORDING)) as Record<string, unknown>;
  return JSON.stringify(mutate(draft));
}

/** An encoded recording with one field removed. */
function without(field: string): string {
  return damaged((draft) => {
    const { [field]: _dropped, ...rest } = draft;
    return rest;
  });
}

describe('a damaged recording', () => {
  it('is refused rather than replayed', () => {
    // §66.2 makes no exception for a file this repository also wrote. An
    // incident is exactly when a file is most likely to arrive truncated.
    expect(() => decodeRecording('null')).toThrow(TypeError);
    expect(() => decodeRecording('[]')).toThrow(TypeError);
  });

  it('names the field that is missing', () => {
    for (const field of ['baseSeedHex', 'clock', 'config', 'tickLogs', 'picks']) {
      expect(() => decodeRecording(without(field))).toThrow(field);
    }
  });

  it('rejects a round index that is not a whole number', () => {
    expect(() => decodeRecording(damaged((draft) => ({ ...draft, roundIndex: 1.5 })))).toThrow(
      TypeError,
    );
  });

  it('rejects tick logs that are not a list', () => {
    expect(() => decodeRecording(damaged((draft) => ({ ...draft, tickLogs: 'nope' })))).toThrow(
      TypeError,
    );
  });
});
