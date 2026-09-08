import type { DurationMs, UtcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_INGEST_STATE,
  evaluateHealth,
  ingest,
  latestSample,
  relativeDivergence,
  sourceKey,
  type FreshnessThresholds,
  type IngestPolicy,
  type IngestState,
  type RawSample,
} from './ingest.js';
import { activeAssets, requireAsset, type AssetRegistry } from './registry.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (T0 + offset) as UtcTimestamp;
const ms = (value: number): DurationMs => value as DurationMs;

const REGISTRY: AssetRegistry = {
  NVDA: {
    ticker: 'NVDA',
    priceFeedId: 'feed-nvda',
    referenceFeedId: 'ref-nvda',
    decimals: 8,
    corporateActionMultiplier: 1,
    status: 'ACTIVE',
    expectedCadence: ms(1_000),
  },
  AAPL: {
    ticker: 'AAPL',
    priceFeedId: 'feed-aapl',
    decimals: 8,
    // A 4-for-1 split: historical prices are four times too high relative to
    // today's until the multiplier is applied.
    corporateActionMultiplier: 0.25,
    status: 'ACTIVE',
    expectedCadence: ms(1_000),
  },
  COIN: {
    ticker: 'COIN',
    priceFeedId: 'feed-coin',
    decimals: 8,
    corporateActionMultiplier: 1,
    status: 'RESERVE',
    expectedCadence: ms(1_000),
  },
};

const POLICY: IngestPolicy = { maxClockSkew: ms(2_000), maxArrivalLag: ms(30_000) };
const FRESHNESS: FreshnessThresholds = { degradedAfter: ms(3_000), staleAfter: ms(10_000) };

/**
 * Builds a provider message.
 *
 * `receivedAt` follows `sourceTimestamp` by default. A fixed receive time would
 * make any message with a later source timestamp look like a clock-skew
 * violation, which is a property of the harness rather than of the case under
 * test.
 */
const raw = (overrides: Partial<RawSample> = {}): RawSample => {
  const sourceTimestamp = overrides.sourceTimestamp ?? at(0);
  return {
    ticker: 'NVDA',
    kind: 'PRICE',
    value: 100,
    sourceId: 'primary',
    sourceTimestamp,
    receivedAt: (sourceTimestamp + 50) as UtcTimestamp,
    sequence: 1,
    ...overrides,
  };
};

const run = (samples: readonly RawSample[]): IngestState => {
  let state = EMPTY_INGEST_STATE;
  for (const sample of samples) {
    state = ingest(state, sample, REGISTRY, POLICY).state;
  }
  return state;
};

describe('registry', () => {
  it('fails loudly on a missing asset', () => {
    // §74.1 requires canonical metadata per asset. Ingesting without it would
    // mean guessing decimals and cadence.
    expect(() => requireAsset(REGISTRY, 'PLTR')).toThrow(RangeError);
  });

  it('separates active from reserve', () => {
    // §4.2: a reserve substitutes before a round, never mid-battle.
    expect(
      activeAssets(REGISTRY)
        .map((a) => a.ticker)
        .sort(),
    ).toEqual(['AAPL', 'NVDA']);
  });
});

describe('structural validation', () => {
  it.each([
    [{ value: Number.NaN }, 'NaN'],
    [{ value: Number.POSITIVE_INFINITY }, 'infinity'],
    [{ value: -1 }, 'negative'],
    [{ sourceTimestamp: (T0 + 0.5) as UtcTimestamp }, 'fractional timestamp'],
  ])('rejects %s (%s)', (overrides, _label) => {
    const outcome = ingest(EMPTY_INGEST_STATE, raw(overrides), REGISTRY, POLICY).outcome;
    expect(outcome.kind).toBe('REJECTED');
  });

  it('publishes nothing when it rejects', () => {
    // An unusable number must produce an honest failure, not a value in the
    // score.
    const { state, outcome } = ingest(
      EMPTY_INGEST_STATE,
      raw({ value: Number.NaN }),
      REGISTRY,
      POLICY,
    );
    expect(outcome.kind).toBe('REJECTED');
    expect(latestSample(state, 'NVDA', 'PRICE')).toBeNull();
  });
});

describe('timestamp validation', () => {
  it('rejects a timestamp implausibly far in the future', () => {
    // A message stamped ahead of now would look permanently fresh and mask a
    // genuine outage.
    const outcome = ingest(
      EMPTY_INGEST_STATE,
      raw({ sourceTimestamp: at(60_000), receivedAt: at(0) }),
      REGISTRY,
      POLICY,
    ).outcome;
    expect(outcome.kind).toBe('REJECTED');
  });

  it('tolerates a small provider clock skew', () => {
    const outcome = ingest(
      EMPTY_INGEST_STATE,
      raw({ sourceTimestamp: at(1_000), receivedAt: at(0) }),
      REGISTRY,
      POLICY,
    ).outcome;
    expect(outcome.kind).toBe('ACCEPTED');
  });

  it('rejects a message that arrived far too late to be current', () => {
    const outcome = ingest(
      EMPTY_INGEST_STATE,
      raw({ sourceTimestamp: at(0), receivedAt: at(120_000) }),
      REGISTRY,
      POLICY,
    ).outcome;
    expect(outcome.kind).toBe('REJECTED');
  });
});

describe('duplicate handling', () => {
  it('ignores a repeat of the same provider message', () => {
    // §74.3: duplicates are ignored by deterministic source key.
    const message = raw();
    let state = ingest(EMPTY_INGEST_STATE, message, REGISTRY, POLICY).state;
    const second = ingest(state, message, REGISTRY, POLICY);
    expect(second.outcome.kind).toBe('DUPLICATE');
    state = second.state;
    expect(latestSample(state, 'NVDA', 'PRICE')?.value).toBe(100);
  });

  it('keys on the provider’s own fields, not the receive time', () => {
    // Receive time differs between nodes; keying on it would let two ingestors
    // accept the same message twice.
    expect(sourceKey(raw({ receivedAt: at(50) }))).toBe(sourceKey(raw({ receivedAt: at(900) })));
    expect(sourceKey(raw({ sequence: 1 }))).not.toBe(sourceKey(raw({ sequence: 2 })));
    expect(sourceKey(raw({ sourceId: 'primary' }))).not.toBe(
      sourceKey(raw({ sourceId: 'backup' })),
    );
  });

  it('treats the same message from two sources as two messages', () => {
    // Two providers reporting the same instant is corroboration, not a
    // duplicate — and §23.7 cross-checks depend on seeing both.
    const state = run([raw({ sourceId: 'primary' })]);
    const outcome = ingest(
      state,
      raw({ sourceId: 'reference', sequence: 2 }),
      REGISTRY,
      POLICY,
    ).outcome;
    expect(outcome.kind).toBe('ACCEPTED');
  });
});

describe('order handling', () => {
  it('refuses to overwrite a newer sample with an older one', () => {
    // §74.4. A late-arriving old price would rewrite the current one and change
    // a live score backwards.
    const state = run([raw({ sourceTimestamp: at(5_000), sequence: 5 })]);
    const outcome = ingest(
      state,
      raw({ sourceTimestamp: at(2_000), sequence: 2 }),
      REGISTRY,
      POLICY,
    ).outcome;

    expect(outcome.kind).toBe('OUT_OF_ORDER');
    expect(latestSample(state, 'NVDA', 'PRICE')?.sourceTimestamp).toBe(at(5_000));
  });

  it('breaks a same-millisecond tie on the provider sequence', () => {
    // Two messages can share a millisecond; the sequence is what orders them.
    const state = run([raw({ sourceTimestamp: at(1_000), sequence: 7 })]);

    const older = ingest(state, raw({ sourceTimestamp: at(1_000), sequence: 6 }), REGISTRY, POLICY);
    expect(older.outcome.kind).toBe('OUT_OF_ORDER');

    const newer = ingest(state, raw({ sourceTimestamp: at(1_000), sequence: 8 }), REGISTRY, POLICY);
    expect(newer.outcome.kind).toBe('ACCEPTED');
  });

  it('keeps streams independent', () => {
    // A volume sample must not be ordered against a price sample.
    const state = run([
      raw({ kind: 'PRICE', sourceTimestamp: at(9_000), sequence: 9 }),
      raw({ kind: 'VOLUME', sourceTimestamp: at(1_000), sequence: 1, value: 42 }),
    ]);
    expect(latestSample(state, 'NVDA', 'VOLUME')?.value).toBe(42);
    expect(latestSample(state, 'NVDA', 'PRICE')?.sourceTimestamp).toBe(at(9_000));
  });
});

describe('corporate-action normalization', () => {
  it('applies the multiplier to prices', () => {
    // §23.8: a 4-for-1 split must not read as a 75% crash and decide a battle.
    const state = run([raw({ ticker: 'AAPL', value: 400 })]);
    const sample = latestSample(state, 'AAPL', 'PRICE');
    expect(sample?.value).toBe(100);
    expect(sample?.corporateActionMultiplier).toBe(0.25);
  });

  it('leaves volume untouched', () => {
    // A split changes what a share is worth, not how many changed hands in the
    // sense §12.2 compares against its own baseline.
    const state = run([raw({ ticker: 'AAPL', kind: 'VOLUME', value: 400 })]);
    expect(latestSample(state, 'AAPL', 'VOLUME')?.value).toBe(400);
  });

  it('records the multiplier so a replay can undo it', () => {
    const state = run([raw({ ticker: 'AAPL', value: 400 })]);
    const sample = latestSample(state, 'AAPL', 'PRICE');
    expect(sample).not.toBeNull();
    expect(sample!.value / sample!.corporateActionMultiplier).toBe(400);
  });
});

describe('health evaluation', () => {
  it('reads absence as unavailable, not stale', () => {
    // The two mean different things to an operator: one provider never
    // connected, the other connected and stopped. §53 starts from that.
    expect(evaluateHealth(null, at(0), FRESHNESS)).toBe('UNAVAILABLE');
  });

  it('grades by age', () => {
    const state = run([raw({ sourceTimestamp: at(0) })]);
    const sample = latestSample(state, 'NVDA', 'PRICE');

    expect(evaluateHealth(sample, at(500), FRESHNESS)).toBe('HEALTHY');
    expect(evaluateHealth(sample, at(2_999), FRESHNESS)).toBe('HEALTHY');
    expect(evaluateHealth(sample, at(3_000), FRESHNESS)).toBe('DEGRADED');
    expect(evaluateHealth(sample, at(9_999), FRESHNESS)).toBe('DEGRADED');
    expect(evaluateHealth(sample, at(10_000), FRESHNESS)).toBe('STALE');
  });

  it('rejects thresholds in the wrong order', () => {
    const state = run([raw()]);
    expect(() =>
      evaluateHealth(latestSample(state, 'NVDA', 'PRICE'), at(0), {
        degradedAfter: ms(10_000),
        staleAfter: ms(3_000),
      }),
    ).toThrow(RangeError);
  });
});

describe('cross-source divergence', () => {
  it('measures the relative gap between two sources', () => {
    // §23.7: abnormal divergence triggers data-health protection rather than
    // silently deciding a winner from suspicious data.
    expect(relativeDivergence(100, 100)).toBe(0);
    expect(relativeDivergence(100, 90)).toBeCloseTo(0.1, 10);
    expect(relativeDivergence(90, 100)).toBeCloseTo(0.1, 10);
  });

  it('is symmetric', () => {
    expect(relativeDivergence(120, 100)).toBe(relativeDivergence(100, 120));
  });

  it('refuses to measure against a non-positive price', () => {
    expect(() => relativeDivergence(0, 100)).toThrow(RangeError);
    expect(() => relativeDivergence(100, -1)).toThrow(RangeError);
  });
});

describe('determinism', () => {
  it('reproduces the same canonical stream from the same messages', () => {
    // A replay must reach the identical canonical samples from recorded
    // provider messages. Nothing in the pipeline reads a clock.
    const messages = [
      raw({ sourceTimestamp: at(0), sequence: 1 }),
      raw({ sourceTimestamp: at(1_000), sequence: 2, value: 101 }),
      raw({ sourceTimestamp: at(500), sequence: 3, value: 99 }),
      raw({ kind: 'VOLUME', sourceTimestamp: at(1_000), sequence: 4, value: 5_000 }),
    ];
    expect(run(messages).latest).toEqual(run(messages).latest);
  });
});
