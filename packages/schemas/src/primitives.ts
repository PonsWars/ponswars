import {
  ACTIVE_TICKERS,
  CARD_DECISIONS,
  CARD_SUPPORT_TIERS,
  CONFIDENCE_LABELS,
  MOMENTUM_STABILITY_SIGNALS,
  MOMENTUM_STATES,
  PONS_ACTIVITY_SIGNALS,
  PRICE_TREND_SIGNALS,
  PUBLIC_FEED_HEALTH,
  RESERVE_TICKERS,
  ROUND_STATES,
  TIEBREAK_ORDER,
  VICTORY_LABELS,
  VISUAL_EVENT_CUES,
  VOID_REASON_CATEGORIES,
  VOLUME_PULSE_SIGNALS,
} from '@ponswars/shared-types';
import { z } from 'zod';

/**
 * Runtime schemas for the primitive shapes every payload is built from.
 *
 * Standard §66.2: *"All public/private API payloads and WebSocket events should
 * use explicit runtime schemas. Validation occurs at ingress, not deep inside
 * business logic."*
 *
 * Every enum here is built from the corresponding const in
 * `@ponswars/shared-types` rather than re-listed. §65.1 allows one canonical
 * definition per concept, and a hand-copied list would be a second one that
 * could drift — a value added to the type but not the schema would be rejected
 * at runtime with a message nobody could explain.
 */

/** Builds a zod enum from a readonly tuple of literals. */
function enumOf<T extends string>(values: readonly T[]): z.ZodEnum<Record<T, T>> {
  return z.enum(Object.fromEntries(values.map((value) => [value, value])) as Record<T, T>);
}

export const activeTickerSchema = enumOf(ACTIVE_TICKERS);
export const tickerSchema = enumOf([...ACTIVE_TICKERS, ...RESERVE_TICKERS]);
export const roundStateSchema = enumOf(ROUND_STATES);
export const confidenceLabelSchema = enumOf(CONFIDENCE_LABELS);
export const priceTrendSignalSchema = enumOf(PRICE_TREND_SIGNALS);
export const volumePulseSignalSchema = enumOf(VOLUME_PULSE_SIGNALS);
export const ponsActivitySignalSchema = enumOf(PONS_ACTIVITY_SIGNALS);
export const momentumStabilitySignalSchema = enumOf(MOMENTUM_STABILITY_SIGNALS);

/**
 * One side's pre-battle intel (§10.2, §27.5).
 *
 * `.strict()`, so the only things that can cross the wire are the label and the
 * four qualitative words. §10 forbids an exact percentage and Guide §7.1 lists
 * one as a mockup error to correct; a numeric field added here in some later
 * refactor would fail this parse rather than reach a client that could render
 * it.
 */
export const confidenceSnapshotSchema = z
  .object({
    label: confidenceLabelSchema,
    priceTrend: priceTrendSignalSchema,
    volumePulse: volumePulseSignalSchema,
    ponsActivity: ponsActivitySignalSchema,
    momentumStability: momentumStabilitySignalSchema,
  })
  .strict();
export const momentumStateSchema = enumOf(MOMENTUM_STATES);
export const victoryLabelSchema = enumOf(VICTORY_LABELS);
export const tiebreakStepSchema = enumOf(TIEBREAK_ORDER);
export const cardDecisionSchema = enumOf(CARD_DECISIONS);
export const cardSupportTierSchema = enumOf(CARD_SUPPORT_TIERS);
export const publicFeedHealthSchema = enumOf(PUBLIC_FEED_HEALTH);
export const visualEventCueSchema = enumOf(VISUAL_EVENT_CUES);
export const voidReasonSchema = enumOf(VOID_REASON_CATEGORIES);

/**
 * A wallet address, normalized to lowercase.
 *
 * Accepting mixed case and lowering it here means a checksummed address and its
 * lowercase form are one identity rather than two — which they would otherwise
 * become the moment one reached a database key.
 */
export const walletAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address')
  .transform((value) => value.toLowerCase());

/** A 32-byte hex hash. */
export const hash32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 0x-prefixed 32-byte hash');

/**
 * A UTC timestamp in milliseconds.
 *
 * Integer only: a fractional millisecond would survive JSON and then compare
 * unpredictably against the round boundaries §72 defines.
 */
export const utcTimestampSchema = z.int().nonnegative();

/** A non-negative duration in milliseconds. */
export const durationMsSchema = z.int().nonnegative();

/** A normalized ratio in `[0, 1]`, used for frontline position and intensity. */
export const unitIntervalSchema = z.number().min(0).max(1);

/**
 * A token amount in integer base units, carried as a decimal **string**.
 *
 * JSON has no integer type large enough and no `bigint`, so an amount sent as a
 * number would silently round past 2^53. Standard §66.3 keeps money exact, and
 * that has to hold across the wire too, not only in memory.
 */
export const baseUnitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'expected an integer amount in base units, as a string');

/** Identifier shapes. Non-empty and bounded, so a payload cannot carry an essay. */
export const roundIdSchema = z.string().min(1).max(64);
export const battleIdSchema = z.string().min(1).max(96);
export const sectorIdSchema = z.string().min(1).max(64);
export const distributionIdSchema = z.string().min(1).max(64);
export const clientRequestIdSchema = z.string().min(8).max(128);
export const eventIdSchema = z.string().min(1).max(128);

/**
 * The canonical clock every round payload carries (§23.5, §72.2).
 *
 * Refined rather than merely typed: the locked timing is one minute to lock and
 * ten to cutoff (§3), so a payload that disagrees is either a bug or something
 * pretending to be this server. Checking it at ingress means a client never
 * renders a countdown built on a malformed round.
 */
export const canonicalClockSchema = z
  .object({
    serverTime: utcTimestampSchema,
    pickOpenAt: utcTimestampSchema,
    lockAt: utcTimestampSchema,
    battleStartAt: utcTimestampSchema,
    battleEndAt: utcTimestampSchema,
  })
  .refine((clock) => clock.lockAt === clock.pickOpenAt + 60_000, {
    message: 'lockAt must be exactly one minute after pickOpenAt (§3.1)',
    path: ['lockAt'],
  })
  .refine((clock) => clock.battleEndAt === clock.pickOpenAt + 600_000, {
    message: 'battleEndAt must be exactly ten minutes after pickOpenAt (§3)',
    path: ['battleEndAt'],
  })
  .refine((clock) => clock.battleStartAt === clock.lockAt, {
    message: 'the scoring window opens exactly at lock (§12.1)',
    path: ['battleStartAt'],
  });

/**
 * One side's four component scores (§12, §27.8).
 *
 * **Every value is scaled by `BATTLE_POINT_SCALE`.** A component reading
 * `23_800_000` is 23.8 points, and both sides' components together always sum
 * to a hundred points scaled. The scale is the reason this is one definition
 * rather than two: a second copy is a second place for someone to assume tenths
 * and render a 48.4 as `4840954.0`, which has happened here once already.
 */
export const battleScoreBreakdownSchema = z
  .object({
    priceMomentum: z.number().nonnegative(),
    relativeVolume: z.number().nonnegative(),
    ponsPower: z.number().nonnegative(),
    holderCardSupport: z.number().nonnegative(),
  })
  .strict();
