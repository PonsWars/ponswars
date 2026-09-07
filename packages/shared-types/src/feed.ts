import type { Ticker } from './roster.js';
import type { UtcTimestamp } from './time.js';

/**
 * Market and chain data feeds, their health, and the integrity rules that can
 * void a battle.
 *
 * Masterplan §23 (realtime infrastructure), §4.4 (feed failure).
 * Kickoff Brief §6: *"Never synthesize a result simply to keep the UI moving."*
 */

/** The three input feeds a battle scores from (§23.1). */
export const FEED_KINDS = ['PRICE', 'VOLUME', 'PONS'] as const;

export type FeedKind = (typeof FEED_KINDS)[number];

/**
 * Feed health (§23.6).
 *
 * Thresholds are source- and data-type-specific and are `OPEN` — they decide
 * when a battle voids, which makes them a product decision rather than a
 * tuning knob. See `docs/OPEN_PARAMETERS.md`.
 */
export const FEED_HEALTH = ['HEALTHY', 'DEGRADED', 'STALE', 'UNAVAILABLE'] as const;

export type FeedHealth = (typeof FEED_HEALTH)[number];

/**
 * Health states a battle can still score from.
 *
 * `DEGRADED` is usable — the data is late but real. `STALE` and `UNAVAILABLE`
 * are not: continuing past them would mean inventing a result, which §4.4 and
 * Brief §6 both forbid.
 */
export const SCORABLE_FEED_HEALTH = [
  'HEALTHY',
  'DEGRADED',
] as const satisfies readonly FeedHealth[];

export function isScorable(health: FeedHealth): boolean {
  return (SCORABLE_FEED_HEALTH as readonly FeedHealth[]).includes(health);
}

/**
 * Whether a required feed in this state forces BATTLE VOID (§4.4).
 *
 * Before a round, an unhealthy asset is substituted from the reserve roster
 * instead (§4.2) — this rule applies only once a battle has started.
 */
export function requiresVoid(health: FeedHealth): boolean {
  return !isScorable(health);
}

/**
 * Provenance every market sample carries (§23.2).
 *
 * Both timestamps are recorded because they answer different questions: the
 * source timestamp says when the market moved, the received timestamp says when
 * this system learned about it, and the gap between them is what freshness
 * thresholds measure.
 */
export interface SampleProvenance {
  readonly sourceId: string;
  readonly sourceTimestamp: UtcTimestamp;
  readonly receivedAt: UtcTimestamp;
  /** Vendor sequence or version number, where the source provides one. */
  readonly sequence?: number;
  readonly health: FeedHealth;
}

/** A normalized market sample ready for the Battle Engine (§23.2). */
export interface MarketSample {
  readonly ticker: Ticker;
  readonly kind: FeedKind;
  /**
   * Normalized value in the feed's own units.
   *
   * Prices and volumes are market data, not token amounts, so they are not
   * `BaseUnits` — §66.3 governs money, and treating a price as money would
   * imply a token precision it does not have.
   */
  readonly value: number;
  readonly provenance: SampleProvenance;
}

/**
 * Public reason categories on a `BATTLE_VOID` event (§48.3).
 *
 * Deliberately minimal, and both are grounded in the masterplan:
 * `DATA_INTEGRITY` is the §4.4 threshold failure whose copy §110.6 fixes, and
 * `MARKET_HALT` is the §23.8 case that must not be treated as ordinary flat
 * price action. Adding a category changes what players are told, so it is a
 * product decision rather than an engineering one.
 */
export const VOID_REASON_CATEGORIES = ['DATA_INTEGRITY', 'MARKET_HALT'] as const;

export type VoidReasonCategory = (typeof VOID_REASON_CATEGORIES)[number];
