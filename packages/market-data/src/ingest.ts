import type {
  DurationMs,
  FeedHealth,
  FeedKind,
  Ticker,
  UtcTimestamp,
} from '@ponswars/shared-types';
import { requireAsset, type AssetRegistry } from './registry.js';

/**
 * The ingestion pipeline (§74.2).
 *
 * ```
 * Provider Message → Parse → Timestamp validation → Sequence/order validation
 *   → Asset normalization → Corporate-action normalization → Health evaluation
 *   → Publish canonical sample
 * ```
 *
 * Implemented as a reducer over an explicit store, for the same reason the
 * battle engine is: a replay must be able to feed recorded provider messages
 * back through the identical code and reach the identical canonical samples.
 * A pipeline that reached for a clock or a database mid-stream could not do
 * that.
 */

/** A message as received from a provider, before any normalization. */
export interface RawSample {
  readonly ticker: Ticker;
  readonly kind: FeedKind;
  /** Value in the provider's own units. */
  readonly value: number;
  readonly sourceId: string;
  /** When the provider says the observation happened. */
  readonly sourceTimestamp: UtcTimestamp;
  /** When this system received it. */
  readonly receivedAt: UtcTimestamp;
  /** Vendor sequence number, where the source provides one. */
  readonly sequence?: number;
}

/** A normalized sample, ready for the Battle Engine (§74.2). */
export interface CanonicalSample {
  readonly ticker: Ticker;
  readonly kind: FeedKind;
  /** Corporate-action adjusted (§23.8). */
  readonly value: number;
  readonly sourceId: string;
  readonly sourceTimestamp: UtcTimestamp;
  readonly receivedAt: UtcTimestamp;
  readonly sequence?: number;
  /** Multiplier applied, retained so a replay can undo it (§26). */
  readonly corporateActionMultiplier: number;
}

export type IngestOutcome =
  /** Accepted and published as the new canonical sample. */
  | { readonly kind: 'ACCEPTED'; readonly sample: CanonicalSample }
  /** Already seen. §74.3 ignores duplicates by deterministic source key. */
  | { readonly kind: 'DUPLICATE'; readonly key: string }
  /** Older than what is already held. §74.4 forbids overwriting a newer sample. */
  | { readonly kind: 'OUT_OF_ORDER'; readonly heldTimestamp: UtcTimestamp }
  /** Structurally unusable. Never published, never silently corrected. */
  | { readonly kind: 'REJECTED'; readonly reason: string };

/**
 * What ingestion remembers.
 *
 * A plain object rather than a class, so it serialises into a checkpoint and a
 * replay can resume from one.
 */
export interface IngestState {
  /** Latest canonical sample per `ticker:kind`. */
  readonly latest: Readonly<Record<string, CanonicalSample>>;
  /** Deterministic source keys already accepted (§74.3). */
  readonly seen: ReadonlySet<string>;
}

export const EMPTY_INGEST_STATE: IngestState = { latest: {}, seen: new Set() };

const streamKey = (ticker: Ticker, kind: FeedKind): string => `${ticker}:${kind}`;

/**
 * Deterministic identity of a provider message (§74.3).
 *
 * Built from source, stream and the provider's own timestamp and sequence — not
 * from receive time, which differs between nodes and would let the same message
 * be accepted twice by two ingestors.
 */
export function sourceKey(raw: RawSample): string {
  return [
    raw.sourceId,
    raw.ticker,
    raw.kind,
    String(raw.sourceTimestamp),
    raw.sequence === undefined ? '-' : String(raw.sequence),
  ].join('|');
}

export interface IngestPolicy {
  /**
   * How far ahead of the receive time a source timestamp may sit.
   *
   * A provider clock runs slightly fast sometimes; a message stamped an hour in
   * the future is a bug or a bad actor. Accepting it would make the sample look
   * permanently fresh and mask a genuine outage.
   */
  readonly maxClockSkew: DurationMs;
  /** How far behind the receive time a source timestamp may sit on arrival. */
  readonly maxArrivalLag: DurationMs;
}

/**
 * Runs one provider message through the pipeline.
 *
 * Pure: state and message in, new state and outcome out. Nothing here reads a
 * clock — `receivedAt` is stamped by the transport at the edge, so a replay
 * feeding recorded messages reproduces the identical canonical stream.
 */
export function ingest(
  state: IngestState,
  raw: RawSample,
  registry: AssetRegistry,
  policy: IngestPolicy,
): { readonly state: IngestState; readonly outcome: IngestOutcome } {
  // Parse and structural validation. A NaN price is not a price; publishing one
  // would put an unusable number into the score rather than an honest failure.
  if (!Number.isFinite(raw.value)) {
    return { state, outcome: { kind: 'REJECTED', reason: 'value is not a finite number' } };
  }
  if (raw.value < 0) {
    return { state, outcome: { kind: 'REJECTED', reason: 'value is negative' } };
  }
  if (!Number.isInteger(raw.sourceTimestamp) || !Number.isInteger(raw.receivedAt)) {
    return {
      state,
      outcome: { kind: 'REJECTED', reason: 'timestamps must be whole milliseconds' },
    };
  }

  // Timestamp validation (§74.2).
  if (raw.sourceTimestamp - raw.receivedAt > policy.maxClockSkew) {
    return {
      state,
      outcome: { kind: 'REJECTED', reason: 'source timestamp is implausibly far in the future' },
    };
  }
  if (raw.receivedAt - raw.sourceTimestamp > policy.maxArrivalLag) {
    return {
      state,
      outcome: { kind: 'REJECTED', reason: 'source timestamp is implausibly far in the past' },
    };
  }

  const key = sourceKey(raw);
  if (state.seen.has(key)) {
    return { state, outcome: { kind: 'DUPLICATE', key } };
  }

  const stream = streamKey(raw.ticker, raw.kind);
  const held = state.latest[stream];

  // Order validation (§74.4): an older source timestamp must not overwrite a
  // newer canonical sample. Where the provider gives a sequence, it decides
  // ties — two messages can share a millisecond.
  if (held !== undefined) {
    if (raw.sourceTimestamp < held.sourceTimestamp) {
      return { state, outcome: { kind: 'OUT_OF_ORDER', heldTimestamp: held.sourceTimestamp } };
    }
    if (
      raw.sourceTimestamp === held.sourceTimestamp &&
      raw.sequence !== undefined &&
      held.sequence !== undefined &&
      raw.sequence <= held.sequence
    ) {
      return { state, outcome: { kind: 'OUT_OF_ORDER', heldTimestamp: held.sourceTimestamp } };
    }
  }

  const asset = requireAsset(registry, raw.ticker);

  // Corporate-action normalization (§23.8, §74.2). A split makes historical
  // prices incomparable with today's; applying the multiplier before the return
  // is calculated is what stops a 4-for-1 reading as a 75% crash.
  const value = raw.kind === 'PRICE' ? raw.value * asset.corporateActionMultiplier : raw.value;

  const sample: CanonicalSample = {
    ticker: raw.ticker,
    kind: raw.kind,
    value,
    sourceId: raw.sourceId,
    sourceTimestamp: raw.sourceTimestamp,
    receivedAt: raw.receivedAt,
    ...(raw.sequence === undefined ? {} : { sequence: raw.sequence }),
    corporateActionMultiplier: asset.corporateActionMultiplier,
  };

  return {
    state: {
      latest: { ...state.latest, [stream]: sample },
      seen: new Set([...state.seen, key]),
    },
    outcome: { kind: 'ACCEPTED', sample },
  };
}

/** The current canonical sample for a stream, if one has been accepted. */
export function latestSample(
  state: IngestState,
  ticker: Ticker,
  kind: FeedKind,
): CanonicalSample | null {
  return state.latest[streamKey(ticker, kind)] ?? null;
}

/**
 * Freshness thresholds, per feed kind (§23.6).
 *
 * `OPEN` in `docs/OPEN_PARAMETERS.md`, and deliberately so: these decide when a
 * battle voids, which makes them a product decision rather than a tuning knob.
 */
export interface FreshnessThresholds {
  /** Beyond this age a sample reads as `DEGRADED` — late but still usable. */
  readonly degradedAfter: DurationMs;
  /** Beyond this age it reads as `STALE` and can void a live battle (§4.4). */
  readonly staleAfter: DurationMs;
}

/**
 * Evaluates feed health for a stream (§23.6).
 *
 * Absence is `UNAVAILABLE`, not `STALE`. The two mean different things to an
 * operator — one provider never connected, the other connected and stopped —
 * and §53 incident response starts from that distinction.
 */
export function evaluateHealth(
  sample: CanonicalSample | null,
  now: UtcTimestamp,
  thresholds: FreshnessThresholds,
): FeedHealth {
  if (sample === null) {
    return 'UNAVAILABLE';
  }
  if (thresholds.staleAfter < thresholds.degradedAfter) {
    throw new RangeError('staleAfter must not be earlier than degradedAfter');
  }

  const age = now - sample.sourceTimestamp;
  if (age >= thresholds.staleAfter) return 'STALE';
  if (age >= thresholds.degradedAfter) return 'DEGRADED';
  return 'HEALTHY';
}

/**
 * Cross-source divergence check (§23.7).
 *
 * *"Abnormal divergence should trigger data-health protection rather than
 * silently determining a winner from suspicious data."* Returns the relative
 * gap so a caller can compare it against a configured tolerance; it does not
 * decide the policy, because that decision voids battles.
 */
export function relativeDivergence(primary: number, reference: number): number {
  if (primary <= 0 || reference <= 0) {
    throw new RangeError('Divergence is undefined for non-positive prices');
  }
  const larger = Math.max(primary, reference);
  return Math.abs(primary - reference) / larger;
}
