import { z } from 'zod';
import {
  activeTickerSchema,
  battleIdSchema,
  battleScoreBreakdownSchema,
  baseUnitsSchema,
  canonicalClockSchema,
  cardDecisionSchema,
  clientRequestIdSchema,
  confidenceSnapshotSchema,
  distributionIdSchema,
  hash32Schema,
  roundIdSchema,
  roundStateSchema,
  tiebreakStepSchema,
  sectorIdSchema,
  tickerSchema,
  utcTimestampSchema,
  victoryLabelSchema,
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

/**
 * What a pick write answers with (§47.5, §66.2, §66.6).
 *
 * `replayed` and `changed` are separate facts and a client shows them
 * differently: a replay is a retry the server already applied, and a change is
 * §27.6's permitted second decision. Collapsing them into one boolean would
 * make a flaky connection look like a player who changed their mind.
 *
 * `.strict()`, like every other payload here, so a field added on the server
 * fails a test rather than reaching a client that ignores it.
 */
export const pickResponseSchema = z
  .object({
    recorded: z.boolean(),
    replayed: z.boolean(),
    changed: z.boolean().optional(),
  })
  .strict();

/**
 * What `GET /v1/roster` answers with (§47.1, §4.1, §4.2).
 *
 * Both lists, because the distinction is the point: a reserve replaces an
 * active asset *before* a round when its data is unhealthy, and is never
 * swapped in mid-battle — that path is a void (§4.4). A single flat list would
 * make the two look interchangeable.
 */
export const rosterSchema = z
  .object({
    active: z.array(activeTickerSchema).length(10),
    reserve: z.array(tickerSchema),
  })
  .strict();

/**
 * What `GET /v1/status` answers with (§47.1).
 *
 * Deliberately thin. A status endpoint that reported queue depths and worker
 * counts would be an operational surface on a public URL; this says whether the
 * service is serving and which round it is serving, which is what a client or a
 * health check needs.
 */
export const serviceStatusSchema = z
  .object({
    status: z.literal('ok'),
    protocolVersion: z.int().positive(),
    round: z.object({ roundId: roundIdSchema, state: roundStateSchema }).strict().nullable(),
  })
  .strict();

/**
 * What `GET /v1/battles/{battleId}/result` answers with (§47.1, §27.8).
 *
 * The same shape the `ROUND_FINALIZED` event carries, because it is the same
 * fact: §25 makes a result immutable from the moment it exists, so the event
 * and the fetch cannot disagree without one of them being wrong.
 *
 * It exists because a client that only learns results from a live event cannot
 * show one after a reload — and the result screen is reached *after* the battle
 * it describes has ended, which is exactly when a player is most likely to
 * arrive fresh.
 */
export const battleResultSchema = z
  .object({
    battleId: battleIdSchema,
    roundId: roundIdSchema,
    left: activeTickerSchema,
    right: activeTickerSchema,
    winner: activeTickerSchema,
    leftScore: battleScoreBreakdownSchema,
    rightScore: battleScoreBreakdownSchema,
    victoryLabel: victoryLabelSchema,
    tiebreakStep: tiebreakStepSchema.optional(),
    scoringEngineVersion: z.string().min(1),
    finalizedAt: utcTimestampSchema,
    evidenceHash: z.string().min(1),
  })
  .strict();

/**
 * What `GET /v1/rounds/{roundId}/pick` answers with (§47.5).
 *
 * `pick: null` means this wallet has not backed anything in this round. It is
 * a fact, not an absence of one — a client that could not tell "no pick" from
 * "not asked yet" would show an empty panel to a player who had committed.
 */
export const myPickSchema = z
  .object({
    pick: z
      .object({
        battleId: battleIdSchema,
        backedTicker: activeTickerSchema,
        cardDecision: cardDecisionSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

/** `PUT /v1/rounds/{roundId}/card-decision` (§47.6). */
export const cardDecisionRequestSchema = z
  .object({
    roundId: roundIdSchema,
    decision: cardDecisionSchema,
    clientRequestId: clientRequestIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Profile (§69.9, §34)
// ---------------------------------------------------------------------------

const countSchema = z.int().nonnegative();

const historyOutcomeSchema = z.enum(['WIN', 'UPSET_VICTORY', 'MAJOR_UPSET', 'LOSS', 'VOID']);

/**
 * `GET /v1/profile` — the connected wallet's own record (§69.9).
 *
 * Everything in it is derived from what finalization wrote: locked picks,
 * results and the War Point ledger. §69.9 also lists the wallet's `$WAR`
 * balance, Genesis state, card and claimable rewards; those are read from the
 * chain, no service publishes them yet, and `holdings` says exactly that rather
 * than answering `null` — which a client would read as "no card".
 *
 * No estimated payout, for the reason `currentRewardsSchema` gives: §16.2 and
 * §110.3 forbid one during an open window.
 */
export const profileSchema = z
  .object({
    wallet: walletAddressSchema,
    lifetime: z
      .object({
        battles: countSchema,
        wins: countSchema,
        losses: countSchema,
        winRateBps: z.int().min(0).max(10_000).nullable(),
        upsets: countSchema,
        majorUpsets: countSchema,
        cardAssistedWins: countSchema,
        warPoints: countSchema,
      })
      .strict(),
    currentWindow: z
      .object({
        warPoints: countSchema,
        qualified: z.boolean(),
        /** `sqrt(WP)` scaled, as a string for the same reason amounts are. */
        weight: baseUnitsSchema,
        window: z
          .object({ distributionId: distributionIdSchema, closesAt: utcTimestampSchema })
          .strict()
          .nullable(),
      })
      .strict(),
    history: z
      .array(
        z
          .object({
            roundId: roundIdSchema,
            battleId: battleIdSchema,
            left: activeTickerSchema,
            right: activeTickerSchema,
            backed: activeTickerSchema,
            outcome: historyOutcomeSchema,
            warPoints: countSchema,
            cardDeployed: z.boolean(),
            settledAt: utcTimestampSchema,
          })
          .strict(),
      )
      .max(100),
    mostBacked: z
      .object({
        ticker: activeTickerSchema,
        battles: countSchema,
        winRateBps: z.int().min(0).max(10_000),
      })
      .strict()
      .nullable(),
    biggestUpset: z
      .object({
        roundId: roundIdSchema,
        winner: activeTickerSchema,
        loser: activeTickerSchema,
        outcome: z.enum(['UPSET_VICTORY', 'MAJOR_UPSET']),
      })
      .strict()
      .nullable(),
    holdings: z.object({ status: z.literal('UNPUBLISHED') }).strict(),
  })
  .strict();

export type Profile = z.infer<typeof profileSchema>;

// ---------------------------------------------------------------------------
// Auth (§47.3)
// ---------------------------------------------------------------------------

/**
 * `POST /v1/auth/challenge` request (§69.4).
 *
 * The chain is named by the caller and checked against the deployment's,
 * because §45.2 requires a signature to match chain policy and the useful
 * moment to say so is before somebody signs — a wallet on the wrong network
 * gets told which one to switch to, rather than a refusal after the prompt.
 */
export const authChallengeRequestSchema = z
  .object({
    wallet: walletAddressSchema,
    chainId: z.int().positive(),
  })
  .strict();

/** `POST /v1/auth/challenge` response: a single-use nonce with an expiry. */
export const authChallengeSchema = z.object({
  nonce: z.string().min(16).max(128),
  expiresAt: z.int().positive(),
  statement: z.string().min(1),
  /**
   * The exact EIP-4361 message to sign.
   *
   * Sent whole rather than assembled by the client from the fields beside it.
   * Two implementations of one format is one implementation too many, and the
   * server verifies against its own copy — so a client that built a different
   * string would produce a signature that recovers to nobody.
   */
  message: z.string().min(1),
  chainId: z.int().positive(),
});

/**
 * `POST /v1/auth/verify` request (§69.5).
 *
 * No message field. The server holds the message it issued under this nonce and
 * verifies against that: a message echoed by the client is either identical, in
 * which case it adds nothing, or different, in which case trusting it is the
 * bug.
 */
export const authVerifyRequestSchema = z
  .object({
    wallet: walletAddressSchema,
    nonce: z.string().min(16).max(128),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

/**
 * `POST /v1/auth/verify` response: the session, once.
 *
 * The token is in this response and nowhere else — the server keeps only a
 * fingerprint of it, so it cannot be re-sent and a client that loses it signs
 * in again.
 */
export const authSessionSchema = z.object({
  token: z.string().min(16),
  wallet: walletAddressSchema,
  expiresAt: z.int().positive(),
});

/** `GET /v1/auth/session` response: what this token is, without re-issuing it. */
export const authSessionInfoSchema = z.object({
  wallet: walletAddressSchema,
  expiresAt: z.int().positive(),
});

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
