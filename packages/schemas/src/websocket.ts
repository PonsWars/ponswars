import { z } from 'zod';
import {
  activeTickerSchema,
  battleIdSchema,
  canonicalClockSchema,
  cardSupportTierSchema,
  confidenceSnapshotSchema,
  distributionIdSchema,
  durationMsSchema,
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

/**
 * The transport every event travels in (§48.1, §48.5, §70.1).
 *
 * These fields used to be spread into each event body, which described a frame
 * nothing sends: it had no `channel`, and §48.1 and §48.2 make the channel the
 * thing a subscription and its authorisation are *about*. Separating transport
 * from content also means one place decides ordering and one place decides
 * meaning, which is what lets the receiver detect a gap without knowing what
 * any event contains.
 *
 * §48.5 also asks for an event id. The transport does not carry one and this
 * does not invent it: a schema describing a field nothing sends is the exact
 * problem this restructure exists to fix. `channel` and `sequence` together
 * identify an event within a gateway, which is as far as one process can go —
 * a genuinely global id is worth adding when a second service starts producing
 * events, and it should be added to the envelope and to this schema together.
 */
export const eventEnvelopeSchema = z.object({
  event: z.string().min(1).max(64),
  version: z.int().positive(),
  /** Monotonic within `channel`, not globally (§48.5, §70.1). */
  sequence: z.int().nonnegative(),
  emittedAt: utcTimestampSchema,
  channel: channelSchema,
});

/** `ROUND_OPENED` (§48.3). */
export const roundOpenedPayloadSchema = z.object({
  roundId: roundIdSchema,
  clock: canonicalClockSchema,
  matchups: z
    .array(
      z.object({
        battleId: battleIdSchema,
        sectorId: sectorIdSchema,
        left: activeTickerSchema,
        right: activeTickerSchema,
        // §10: qualitative words only. There is deliberately no numeric
        // confidence field here — Guide §7.1 flags an exact percentage as a
        // mockup error, and a number on the wire is a number a UI will render.
        // `confidenceSnapshotSchema` is strict, so one cannot be added quietly.
        leftIntel: confidenceSnapshotSchema,
        rightIntel: confidenceSnapshotSchema,
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
export const battleStateUpdatePayloadSchema = z
  .object({
    battleId: battleIdSchema,
    /**
     * When the engine produced this reading (§23.5).
     *
     * In the payload as well as the envelope, and not a duplicate of it: the
     * envelope's `emittedAt` is when the gateway sent the frame, and a tick
     * that queued behind a slow publish would otherwise appear to have been
     * measured later than it was.
     */
    serverTime: utcTimestampSchema,
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
export const picksLockedPayloadSchema = z
  .object({
    roundId: roundIdSchema,
    /**
     * The matchups, repeated at lock.
     *
     * §48.3 asks only for the round id, and this carries more on purpose: a
     * client that connected after `ROUND_OPENED` would otherwise have to fetch
     * a snapshot to learn what it is now watching, at the exact moment five
     * battles start.
     */
    battles: z
      .array(
        z
          .object({
            battleId: battleIdSchema,
            left: activeTickerSchema,
            right: activeTickerSchema,
          })
          .strict(),
      )
      .length(5),
  })
  .strict();

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
export const roundFinalizedPayloadSchema = z.object({
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
  /**
   * Battles the round could not score (§25, §61 principle 19).
   *
   * Part of the result and not an omission from it. A round that finalized four
   * battles and voided one has to say so, or a client shows four results and a
   * battle that never ended.
   */
  voided: z.array(battleIdSchema),
});

/**
 * `BATTLE_VOID` (§48.3).
 *
 * The refund flag is part of the event because §110.6 fixes the copy that goes
 * with it — *"Any deployed card use for this battle has been restored"* — and a
 * client should not have to infer whether that sentence is true.
 */
export const battleVoidPayloadSchema = z.object({
  battleId: battleIdSchema,
  reason: voidReasonSchema,
  cardUseRestored: z.boolean(),
});

/**
 * Which payload belongs to which public event name (§48.3).
 *
 * The five names are the contract. An event this map does not know is not
 * validated into something plausible — `parseEventFrame` refuses it, because a
 * client that guessed at an unknown event would be rendering a protocol nobody
 * agreed to.
 */
export const PUBLIC_EVENT_PAYLOADS = {
  ROUND_OPENED: roundOpenedPayloadSchema,
  BATTLE_STATE_UPDATE: battleStateUpdatePayloadSchema,
  PICKS_LOCKED: picksLockedPayloadSchema,
  ROUND_FINALIZED: roundFinalizedPayloadSchema,
  BATTLE_VOID: battleVoidPayloadSchema,
} as const;

export type PublicEventName = keyof typeof PUBLIC_EVENT_PAYLOADS;

export const PUBLIC_EVENT_NAMES = Object.keys(PUBLIC_EVENT_PAYLOADS) as readonly PublicEventName[];

// ---------------------------------------------------------------------------
// Private events (§48.4)
// ---------------------------------------------------------------------------

export const pickConfirmedPayloadSchema = z.object({
  wallet: walletAddressSchema,
  roundId: roundIdSchema,
  battleId: battleIdSchema,
  backedTicker: activeTickerSchema,
  revision: z.int().positive(),
});

export const pickRejectedPayloadSchema = z.object({
  wallet: walletAddressSchema,
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

export const cardEventPayloadSchema = z.object({
  wallet: walletAddressSchema,
  roundId: roundIdSchema,
  remainingUses: z.int().nonnegative(),
});

export const wpCreditedPayloadSchema = z.object({
  wallet: walletAddressSchema,
  battleId: battleIdSchema,
  reason: z.enum(['WIN', 'UNDERDOG_WIN', 'HEAVY_UNDERDOG_WIN', 'CARD_ASSIST']),
  points: z.int().positive(),
});

export const rewardFinalizedPayloadSchema = z.object({
  wallet: walletAddressSchema,
  distributionId: distributionIdSchema,
  /** Base units as a string: an amount sent as a JSON number would round. */
  amount: baseUnitsSchema,
});

export const secretEventPayloadSchema = z.object({
  wallet: walletAddressSchema,
  entitlementId: z.string().min(1).max(64),
  amount: baseUnitsSchema,
  transactionHash: hash32Schema.optional(),
});

/**
 * Which payload belongs to which private event name (§48.4).
 *
 * Several names share one payload where the shape is the same and only the verb
 * differs — arming, deploying and restoring a card all report the same wallet,
 * round and remaining uses. The name lives in the envelope, so they no longer
 * need a discriminator inside the body to tell them apart.
 */
export const PRIVATE_EVENT_PAYLOADS = {
  PICK_CONFIRMED: pickConfirmedPayloadSchema,
  PICK_REJECTED: pickRejectedPayloadSchema,
  CARD_ARMED: cardEventPayloadSchema,
  CARD_DEPLOYED: cardEventPayloadSchema,
  CARD_USE_RESTORED: cardEventPayloadSchema,
  WP_CREDITED: wpCreditedPayloadSchema,
  REWARD_FINALIZED: rewardFinalizedPayloadSchema,
  SECRET_RESERVED: secretEventPayloadSchema,
  SECRET_CLAIMED: secretEventPayloadSchema,
} as const;

export type PrivateEventName = keyof typeof PRIVATE_EVENT_PAYLOADS;

/**
 * Parses one frame off the wire (§66.2).
 *
 * Envelope first, then the payload its event name calls for. An unknown event
 * is refused rather than passed through with an unchecked payload: a client
 * that rendered whatever arrived under a name it did not recognise would be
 * following a protocol nobody agreed to.
 */
export function parseEventFrame(
  value: unknown,
  payloads: Readonly<Record<string, z.ZodType>> = PUBLIC_EVENT_PAYLOADS,
):
  | {
      readonly ok: true;
      readonly event: string;
      readonly channel: string;
      readonly payload: unknown;
    }
  | { readonly ok: false; readonly reason: string } {
  const envelope = eventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return { ok: false, reason: envelope.error.issues[0]?.message ?? 'malformed envelope' };
  }

  const schema = payloads[envelope.data.event];
  if (schema === undefined) {
    return { ok: false, reason: `unknown event ${envelope.data.event}` };
  }

  const payload = schema.safeParse((value as { payload?: unknown }).payload);
  if (!payload.success) {
    return { ok: false, reason: payload.error.issues[0]?.message ?? 'malformed payload' };
  }

  return {
    ok: true,
    event: envelope.data.event,
    channel: envelope.data.channel,
    payload: payload.data,
  };
}
