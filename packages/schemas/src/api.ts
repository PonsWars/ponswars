import { z } from 'zod';
import {
  activeTickerSchema,
  battleIdSchema,
  baseUnitsSchema,
  canonicalClockSchema,
  cardDecisionSchema,
  clientRequestIdSchema,
  confidenceSnapshotSchema,
  distributionIdSchema,
  hash32Schema,
  roundIdSchema,
  roundStateSchema,
  sectorIdSchema,
  walletAddressSchema,
} from './primitives.js';

/**
 * Request and response schemas for the public and player APIs (§47).
 *
 * Requests are parsed at ingress (§66.2). Responses are schema'd too, which is
 * less usual but earns its keep here: the rule that a live battle must not
 * expose its score is a property of what the server *sends*, and a schema is
 * where that can be asserted rather than reviewed.
 */

// ---------------------------------------------------------------------------
// Picks (§47.5)
// ---------------------------------------------------------------------------

/**
 * `PUT /v1/rounds/{roundId}/pick`.
 *
 * There is no timestamp field, deliberately. §47.5 says the backend stores
 * trusted receive and commit timestamps; accepting a client's idea of when it
 * picked would hand a latency argument to anyone who missed the lock.
 */
export const pickRequestSchema = z
  .object({
    roundId: roundIdSchema,
    battleId: battleIdSchema,
    backedTicker: activeTickerSchema,
    cardDecision: cardDecisionSchema,
    /** §66.6 idempotency key: a retry carries the same one. */
    clientRequestId: clientRequestIdSchema,
  })
  .strict();

export type PickRequest = z.infer<typeof pickRequestSchema>;

/** `PUT /v1/rounds/{roundId}/card-decision` (§47.6). */
export const cardDecisionRequestSchema = z
  .object({
    roundId: roundIdSchema,
    decision: cardDecisionSchema,
    clientRequestId: clientRequestIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Auth (§47.3)
// ---------------------------------------------------------------------------

/** `POST /v1/auth/challenge` response: a single-use nonce with an expiry. */
export const authChallengeSchema = z.object({
  nonce: z.string().min(16).max(128),
  expiresAt: z.int().positive(),
  statement: z.string().min(1),
});

export const authVerifyRequestSchema = z
  .object({
    wallet: walletAddressSchema,
    nonce: z.string().min(16).max(128),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

// ---------------------------------------------------------------------------
// Public reads (§47.1)
// ---------------------------------------------------------------------------

/**
 * A battle as served while the round is live.
 *
 * `.strict()` and the absence of any score field are the point. §47.1 requires
 * that a public battle response *"must not expose exact hidden live battle
 * score while the battle is active"*, and a strict schema turns that from a
 * review item into a failing parse.
 */
export const liveBattleSchema = z
  .object({
    battleId: battleIdSchema,
    roundId: roundIdSchema,
    sectorId: sectorIdSchema,
    left: activeTickerSchema,
    right: activeTickerSchema,
    leftIntel: confidenceSnapshotSchema,
    rightIntel: confidenceSnapshotSchema,
    state: z.enum(['SCHEDULED', 'LIVE', 'FINALIZED', 'VOID']),
  })
  .strict();

/** `GET /v1/rounds/current` (§47.1, §27.4). */
export const currentRoundSchema = z
  .object({
    roundId: roundIdSchema,
    state: roundStateSchema,
    clock: canonicalClockSchema,
    battles: z.array(liveBattleSchema).length(5),
  })
  .strict();

export type CurrentRound = z.infer<typeof currentRoundSchema>;

// ---------------------------------------------------------------------------
// Rewards (§47.7)
// ---------------------------------------------------------------------------

/**
 * `GET /v1/rewards/current`.
 *
 * §16.2 and §110.3 forbid showing an estimated SPY payout during an active
 * window — a delivered mockup does exactly that. What a player may see is their
 * War Points, their reward weight, whether they qualify and the pool status;
 * the schema carries those and has no field for an estimate.
 */
export const currentRewardsSchema = z
  .object({
    distributionId: distributionIdSchema,
    windowStart: z.int().positive(),
    windowEnd: z.int().positive(),
    windowWarPoints: z.int().nonnegative(),
    /** `sqrt(WP)` scaled, as a string for the same reason amounts are. */
    rewardWeight: baseUnitsSchema,
    qualified: z.boolean(),
    poolBalance: baseUnitsSchema,
  })
  .strict();

/** `GET /v1/rewards/distributions/{id}/proof` (§47.7). */
export const claimProofSchema = z
  .object({
    distributionId: distributionIdSchema,
    wallet: walletAddressSchema,
    amount: baseUnitsSchema,
    proof: z.array(hash32Schema),
    contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    rewardToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();

// ---------------------------------------------------------------------------
// Secret vault (§47.8)
// ---------------------------------------------------------------------------

/**
 * `GET /v1/secret-vault/status`.
 *
 * §8.6 keeps this coarse: the UI should not emphasise remaining Secret
 * inventory, so the response carries a state and the fixed reward, not a
 * balance or a count of Secrets left.
 */
export const secretVaultStatusSchema = z
  .object({
    state: z.enum(['ACTIVE', 'DORMANT']),
    rewardAmount: baseUnitsSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Errors (§110.5)
// ---------------------------------------------------------------------------

/**
 * The error envelope.
 *
 * §110.5 requires every system error to say three things: what happened,
 * whether the user's funds and state are safe, and what they can do next. The
 * schema makes all three required, so an error that omits one cannot be sent.
 */
export const apiErrorSchema = z
  .object({
    code: z.string().min(1),
    /** What happened. */
    message: z.string().min(1),
    /** Whether funds and state are safe. */
    stateIsSafe: z.boolean(),
    /** What the user can do next. */
    nextStep: z.string().min(1),
    correlationId: z.string().min(1),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
