import { z } from 'zod';
import {
  activeTickerSchema,
  battleIdSchema,
  canonicalClockSchema,
  cardSupportTierSchema,
  confidenceLabelSchema,
  distributionIdSchema,
  durationMsSchema,
  eventIdSchema,
  hash32Schema,
  momentumStateSchema,
  publicFeedHealthSchema,
  roundIdSchema,
  sectorIdSchema,
  unitIntervalSchema,
  utcTimestampSchema,
  victoryLabelSchema,
  visualEventCueSchema,
  voidReasonSchema,
  walletAddressSchema,
  baseUnitsSchema,
} from './primitives.js';

/**
 * The WebSocket event model (§48).
 *
 * Every event carries an id, a server timestamp and a monotonic sequence
 * (§48.5), so a client can tell a replayed event from a new one and can detect
 * a gap without guessing. §24 requires a client that misses events to request a
 * snapshot rather than assume perfect delivery, and the sequence is what makes
 * "I missed something" detectable at all.
 */

const envelope = {
  eventId: eventIdSchema,
  serverTime: utcTimestampSchema,
  /** Monotonic within its own stream (§48.5). */
  sequence: z.int().nonnegative(),
};

/** `ROUND_OPENED` (§48.3). */
export const roundOpenedSchema = z.object({
  type: z.literal('ROUND_OPENED'),
  ...envelope,
  roundId: roundIdSchema,
  clock: canonicalClockSchema,
  matchups: z
    .array(
      z.object({
        battleId: battleIdSchema,
        sectorId: sectorIdSchema,
        left: activeTickerSchema,
        right: activeTickerSchema,
        // §10: qualitative labels only. There is deliberately no numeric
        // confidence field here — Guide §7.1 flags an exact percentage as a
        // mockup error, and a number on the wire is a number a UI will render.
        leftConfidence: confidenceLabelSchema,
        rightConfidence: confidenceLabelSchema,
      }),
    )
    // §4.3: exactly five simultaneous battles.
    .length(5),
});

/**
 * `BATTLE_STATE_UPDATE` (§48.3).
 *
 * **Carries no score, and must never gain one.** §24 and §48.3 both say it
 * directly, and three of the delivered mockup PNGs show a live exact score — so
 * the constraint lives in the schema, where an added field fails a test rather
 * than passing review.
 *
 * `.strict()` matters here more than anywhere else: without it, a server that
 * started attaching a score would have the field silently stripped on the way
 * in and pass validation, hiding the leak instead of catching it.
 */
export const battleStateUpdateSchema = z
  .object({
    type: z.literal('BATTLE_STATE_UPDATE'),
    ...envelope,
    battleId: battleIdSchema,
    timeRemaining: durationMsSchema,
    momentum: momentumStateSchema,
    frontline: unitIntervalSchema,
    intensity: unitIntervalSchema,
    cardSupport: cardSupportTierSchema,
    feedHealth: publicFeedHealthSchema,
    visualEvent: visualEventCueSchema.optional(),
  })
  .strict();

/** `PICKS_LOCKED` (§48.3). */
export const picksLockedSchema = z.object({
  type: z.literal('PICKS_LOCKED'),
  ...envelope,
  roundId: roundIdSchema,
});

/** One side's final component breakdown, revealed only after finalization. */
const scoreBreakdownSchema = z.object({
  priceMomentum: z.number().nonnegative(),
  relativeVolume: z.number().nonnegative(),
  ponsPower: z.number().nonnegative(),
  holderCardSupport: z.number().nonnegative(),
});

/**
 * `ROUND_FINALIZED` (§48.3).
 *
 * This is the first and only event that carries exact scores. §12.6 reveals the
 * breakdown at finalization, and §27.8 shows it on the result screen.
 */
export const roundFinalizedSchema = z.object({
  type: z.literal('ROUND_FINALIZED'),
  ...envelope,
  roundId: roundIdSchema,
  results: z.array(
    z
      .object({
        battleId: battleIdSchema,
        left: activeTickerSchema,
        right: activeTickerSchema,
        winner: activeTickerSchema,
        leftScore: scoreBreakdownSchema,
        rightScore: scoreBreakdownSchema,
        victoryLabel: victoryLabelSchema,
        evidenceHash: z.string().min(1),
      })
      .refine((result) => result.winner === result.left || result.winner === result.right, {
        message: 'the winner must be one of the two participants',
        path: ['winner'],
      }),
  ),
});

/**
 * `BATTLE_VOID` (§48.3).
 *
 * The refund flag is part of the event because §110.6 fixes the copy that goes
 * with it — *"Any deployed card use for this battle has been restored"* — and a
 * client should not have to infer whether that sentence is true.
 */
export const battleVoidSchema = z.object({
  type: z.literal('BATTLE_VOID'),
  ...envelope,
  battleId: battleIdSchema,
  reason: voidReasonSchema,
  cardUseRestored: z.boolean(),
});

export const publicEventSchema = z.discriminatedUnion('type', [
  roundOpenedSchema,
  battleStateUpdateSchema,
  picksLockedSchema,
  roundFinalizedSchema,
  battleVoidSchema,
]);

export type PublicEvent = z.infer<typeof publicEventSchema>;

// ---------------------------------------------------------------------------
// Private events (§48.4)
// ---------------------------------------------------------------------------

const privateEnvelope = { ...envelope, wallet: walletAddressSchema };

export const pickConfirmedSchema = z.object({
  type: z.literal('PICK_CONFIRMED'),
  ...privateEnvelope,
  roundId: roundIdSchema,
  battleId: battleIdSchema,
  backedTicker: activeTickerSchema,
  revision: z.int().positive(),
});

export const pickRejectedSchema = z.object({
  type: z.literal('PICK_REJECTED'),
  ...privateEnvelope,
  roundId: roundIdSchema,
  /**
   * Why it was refused.
   *
   * `PICKS_CLOSED` is the §72.4 case: a request that arrived after `lock_at`
   * even though the sender's screen still showed time. §110.5 requires an error
   * to say what happened and what the user can do, so the reason travels with
   * the event rather than being guessed from a status code.
   */
  reason: z.enum(['PICKS_CLOSED', 'ALREADY_PICKED', 'UNKNOWN_BATTLE', 'NOT_ELIGIBLE']),
});

export const cardEventSchema = z.object({
  type: z.enum(['CARD_ARMED', 'CARD_DEPLOYED', 'CARD_USE_RESTORED']),
  ...privateEnvelope,
  roundId: roundIdSchema,
  remainingUses: z.int().nonnegative(),
});

export const wpCreditedSchema = z.object({
  type: z.literal('WP_CREDITED'),
  ...privateEnvelope,
  battleId: battleIdSchema,
  reason: z.enum(['WIN', 'UNDERDOG_WIN', 'HEAVY_UNDERDOG_WIN', 'CARD_ASSIST']),
  points: z.int().positive(),
});

export const rewardFinalizedSchema = z.object({
  type: z.literal('REWARD_FINALIZED'),
  ...privateEnvelope,
  distributionId: distributionIdSchema,
  /** Base units as a string: an amount sent as a JSON number would round. */
  amount: baseUnitsSchema,
});

export const secretEventSchema = z.object({
  type: z.enum(['SECRET_RESERVED', 'SECRET_CLAIMED']),
  ...privateEnvelope,
  entitlementId: z.string().min(1).max(64),
  amount: baseUnitsSchema,
  transactionHash: hash32Schema.optional(),
});

export const privateEventSchema = z.discriminatedUnion('type', [
  pickConfirmedSchema,
  pickRejectedSchema,
  cardEventSchema,
  wpCreditedSchema,
  rewardFinalizedSchema,
  secretEventSchema,
]);

export type PrivateEvent = z.infer<typeof privateEventSchema>;

/**
 * Channel names (§48.1, §48.2).
 *
 * A private channel is bound to one wallet, and §48.2 requires the session to
 * own that address. Parsing the name here does not authorise anything — it only
 * makes the claim explicit so the gateway has something to check.
 */
export const channelSchema = z.union([
  z.literal('world'),
  z.string().regex(/^round:[\w-]{1,64}$/),
  z.string().regex(/^battle:[\w-]{1,96}$/),
  // The wallet channel is matched on a lowercase address only. §48.2 binds the
  // channel to one wallet, and accepting mixed case would let two spellings of
  // one address look like two subscriptions.
  z.string().regex(/^wallet:0x[0-9a-f]{40}$/),
]);
