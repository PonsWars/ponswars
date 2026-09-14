import {
  nextRoundAction,
  sectorIds,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import { CHALLENGE_STATEMENT, type AuthService } from '@ponswars/auth';
import {
  authChallengeRequestSchema,
  authChallengeSchema,
  authSessionInfoSchema,
  authSessionSchema,
  authVerifyRequestSchema,
  cardDecisionRequestSchema,
  battleResultSchema,
  genesisStatusSchema,
  rewardClaimsSchema,
  type GenesisClaimBody,
  type GenesisStatusBody,
  currentRoundSchema,
  rosterSchema,
  serviceStatusSchema,
  myPickSchema,
  profileSchema,
  pickRequestSchema,
  pickResponseSchema,
} from '@ponswars/schemas';
import {
  ACTIVE_TICKERS,
  RESERVE_TICKERS,
  battleId as toBattleId,
  clientRequestId as toClientRequestId,
  roundId as toRoundId,
  type FinalizedBattleResult,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { PROTOCOL_VERSION } from '@ponswars/realtime';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  battleNotInRound,
  chainUnavailable,
  genesisRequestNotFound,
  genesisUnavailable,
  invalidRequest,
  noCardToUse,
  noPickToDecide,
  resultNotFound,
  picksClosed,
  roundNotFound,
  signInRefused,
  tickerNotInBattle,
  unauthenticated,
  wrongChain,
  type ErrorResponse,
} from './errors.js';
import type { PlayerRecordSource } from '@ponswars/player-service';
import {
  GenesisChainError,
  genesisRequestId,
  type GenesisClaim,
  type GenesisStatus,
} from '@ponswars/genesis-service';
import {
  PicksLockedError,
  canDeploy,
  type CardHoldings,
  type PickRepository,
} from '@ponswars/round-service';

/**
 * The HTTP surface (§47).
 *
 * It validates, authorises and records. It decides nothing the engine decides:
 * whether picks are open comes from `nextRoundAction` against server time, not
 * from a countdown or a stored boolean, so there is no second copy of §3.2's
 * timing to disagree with the first.
 *
 * Built as a function returning an instance rather than a module that listens.
 * Fastify's `inject` then exercises every route without a port, which is what
 * makes the tests real requests instead of function calls.
 */

export interface ServerDeps {
  /** The round in play, or `null` before one is loaded. */
  readonly currentRound: () => RoundEngineState | null;
  readonly picks: PickRepository;
  readonly config: EngineConfig;
  /**
   * Server time (§23.5).
   *
   * Injected rather than read from `Date.now()` inside a handler, so a test can
   * put a request on either side of a lock boundary to the millisecond — which
   * is the only way to check the boundary is where §3.2 says it is.
   */
  readonly now: () => UtcTimestamp;
  /**
   * The wallet proven by the session, or `null` for a spectator.
   *
   * Signature verification is §45.2 and belongs to the auth service; this takes
   * the result. Spectating needs no wallet at all (§5), so `null` is normal and
   * only writes reject it.
   *
   * Asynchronous because a session lives in a database: it has to survive a
   * restart and be revocable, and neither is possible for a token this process
   * can settle on its own.
   */
  readonly walletOf: (authorization: string | undefined) => Promise<WalletAddress | null>;
  /**
   * Wallet sign-in (§45.2, §69.4, §69.5).
   *
   * The service rather than four functions, because the four endpoints below
   * are one flow and splitting them across the dependency boundary would let a
   * composition wire half of it.
   */
  readonly auth: AuthService;
  /**
   * Browser origins allowed to read this API.
   *
   * No default, and no wildcard shortcut. §5 makes spectating the normal case,
   * so a browser has to be able to reach this — but *which* browsers is a
   * deployment fact, and `*` would also hand any page on the internet the
   * ability to make authenticated requests on a visitor's behalf if credentials
   * were ever enabled.
   *
   * An empty list is a valid answer meaning "no browser": a service reached
   * only by other services needs no CORS at all, and saying so explicitly is
   * different from forgetting.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * A finalized result by battle, or `null` if that battle has not finished.
   *
   * A lookup rather than a store, because §25 makes a result immutable once it
   * exists and this endpoint only reads. Where the results are kept is the
   * store adapter's business (§102) and not this server's.
   *
   * Asynchronous because every store that outlives a process is: the lookup is
   * a query. A synchronous signature was only possible while the sole
   * implementation was an array in memory, and it would have made the durable
   * one — the one deployments actually run — impossible to write.
   */
  readonly finalizedResult: (battleId: string) => Promise<FinalizedBattleResult | null>;
  /**
   * The connected wallet's record (§69.9).
   *
   * A source rather than a store, for the same reason `finalizedResult` is a
   * lookup: a record is derived from what finalization wrote, and this server
   * only reads it.
   */
  readonly playerRecords: PlayerRecordSource;
  /**
   * Who holds a Genesis card with a charge to spend (§6, §40.7).
   *
   * Asked before any request that arms one. A card a wallet does not hold earns
   * support and a card assist exactly like a real one if it reaches the engine,
   * so it must not get as far as being recorded.
   */
  readonly cards: CardHoldings;
  /**
   * The wallet's `$WAR` on Robinhood Chain, in base units, with the token's
   * decimals (§34.1).
   *
   * Absent where nothing reads the chain — the local stack — and the profile
   * then says the balance is unpublished rather than zero.
   */
  readonly warBalanceOf?: (
    wallet: WalletAddress,
  ) => Promise<{ readonly balance: bigint; readonly decimals: number }>;
  /**
   * Genesis claims (§6, §9, §69.6).
   *
   * Absent where nothing reads the chain: a card is dealt from a finalized
   * Robinhood Chain block, and a server without one cannot deal a card it
   * could stand behind.
   */
  /**
   * Published rewards and where to claim them (§16.8, §17).
   *
   * Absent where there is no distributor to claim from.
   */
  readonly rewardClaims?: {
    readonly chainId: number;
    readonly distributor: `0x${string}`;
    readonly decimals: number;
    claimsOf(wallet: WalletAddress): Promise<
      readonly {
        readonly distributionId: bigint;
        readonly amount: bigint;
        readonly proof: readonly `0x${string}`[];
      }[]
    >;
    hasClaimed(distributionId: bigint, wallet: WalletAddress): Promise<boolean>;
  };
  readonly genesis?: {
    status(wallet: WalletAddress): Promise<GenesisStatus>;
    request(wallet: WalletAddress): Promise<GenesisStatus>;
    claimOf(wallet: WalletAddress): Promise<GenesisClaim | null>;
  };
}

/**
 * How long a profile waits for the chain before answering without the balance.
 *
 * The record is the database's and is ready in milliseconds; an RPC endpoint
 * having a slow minute should cost the player the one figure it owes, not the
 * whole page. A constant with a reason rather than an `OPEN` value (§102): no
 * figure changes with it, only how long a slow read is waited for.
 */
export const CHAIN_READ_TIMEOUT_MS = 2_500;

/**
 * The token out of an `Authorization` header, or `null`.
 *
 * `Bearer <token>` and nothing else. A scheme this does not recognise is not a
 * token to try anyway: `walletOf` would hash whatever was there and look it up,
 * which cannot succeed but does turn a malformed header into a database query.
 */
export function bearer(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  return match?.[1] ?? null;
}

/** The largest request body the API reads, in bytes. */
export const MAX_BODY_BYTES = 16_384;

/**
 * The `$WAR` holding a profile reports: read, not read here, or not read now.
 *
 * A failed or slow read is `UNAVAILABLE`, never zero — §42.14's rule about a
 * figure nobody has read, applied to the one that matters most to a holder.
 */
async function warHolding(
  read: ServerDeps['warBalanceOf'],
  wallet: WalletAddress,
): Promise<
  | { status: 'READ'; balance: string; decimals: number }
  | { status: 'UNPUBLISHED' }
  | { status: 'UNAVAILABLE' }
> {
  if (read === undefined) {
    return { status: 'UNPUBLISHED' };
  }
  const holding = await withinChainTimeout(read(wallet));
  return holding === null
    ? { status: 'UNAVAILABLE' }
    : { status: 'READ', balance: holding.balance.toString(), decimals: holding.decimals };
}

/**
 * A chain read's answer, or `null` if it failed or outlasted
 * {@link CHAIN_READ_TIMEOUT_MS} — so a slow endpoint costs the figure, not the page.
 */
async function withinChainTimeout<T>(read: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, CHAIN_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The card a profile shows: the claim, with the charges its card has left.
 *
 * Read from the record only — a profile never finishes a pending claim. A claim
 * with no card behind it is a broken record, not a wallet without a card, so it
 * is raised rather than answered as `null`.
 */
async function genesisHolding(
  deps: ServerDeps,
  wallet: WalletAddress,
): Promise<
  | {
      status: 'READ';
      card: {
        genesisId: string;
        rarity: GenesisClaim['rarity'];
        cardType: GenesisClaim['cardType'];
        initialUses: number;
        remainingUses: number;
      } | null;
    }
  | { status: 'UNPUBLISHED' }
> {
  if (deps.genesis === undefined) {
    return { status: 'UNPUBLISHED' };
  }
  const claim = await deps.genesis.claimOf(wallet);
  if (claim === null) {
    return { status: 'READ', card: null };
  }
  const holding = await deps.cards.cardOf(wallet);
  if (holding?.cardInstanceId !== claim.cardInstanceId) {
    throw new Error(`Genesis claim ${claim.genesisId} has no card on record for ${wallet}`);
  }
  return {
    status: 'READ',
    card: {
      genesisId: claim.genesisId,
      rarity: claim.rarity,
      cardType: claim.cardType,
      initialUses: claim.initialUses,
      remainingUses: holding.remainingUses,
    },
  };
}

/** A Genesis status as the API says it (§69.6). */
function genesisBody(status: GenesisStatus): GenesisStatusBody {
  switch (status.kind) {
    case 'NONE':
      return { status: 'NONE' };
    case 'NOT_ELIGIBLE_BALANCE':
      return {
        status: 'NOT_ELIGIBLE_BALANCE',
        balance: status.balance.toString(),
        threshold: status.threshold.toString(),
        decimals: status.decimals,
      };
    case 'PENDING_FINALITY':
      return {
        status: 'PENDING_FINALITY',
        requestId: status.requestId,
        targetBlock: status.targetBlock,
      };
    case 'SECRET_RESERVATION_PENDING':
      return { status: 'SECRET_RESERVATION_PENDING', requestId: status.requestId };
    case 'READY':
    case 'ALREADY_CLAIMED':
      return { status: status.kind, claim: claimBody(status.claim) };
  }
}

function claimBody(claim: GenesisClaim): GenesisClaimBody {
  return {
    genesisId: claim.genesisId,
    requestId: claim.requestId,
    wallet: claim.wallet,
    rarity: claim.rarity,
    cardType: claim.cardType,
    initialUses: claim.initialUses,
    slot: claim.slot,
    seed: claim.seed,
    entropyBlock: claim.entropyBlock,
    entropyBlockHash: claim.entropyBlockHash,
    secretAvailable: claim.secretAvailable,
    rarityTableVersion: claim.rarityTableVersion,
    secretReservationTx: claim.secretReservationTx,
    finalizedAt: claim.finalizedAt,
  };
}

/** Stands in for a write the store refused because the round's picks froze. */
const LOCKED = Symbol('picks locked');

/**
 * A pick write, with the store's lock refusal turned into a value.
 *
 * The phase is checked before every write, but that check and the round's lock
 * are two moments, and a write can land between them. The store refuses it
 * (§22); the player is owed the same answer as one who arrived a second later —
 * picks are closed — rather than a server error for having been unlucky.
 */
async function lockedAs<T>(write: Promise<T>): Promise<T | typeof LOCKED> {
  try {
    return await write;
  } catch (error: unknown) {
    if (error instanceof PicksLockedError) {
      return LOCKED;
    }
    throw error;
  }
}

/** Correlation id for one request, so an error can be traced (§110.5). */
function correlationId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    // The largest body this API accepts is a pick: a few hundred bytes. The
    // framework's default is a mebibyte, parsed as JSON before any route looks
    // at it — work any visitor could make every instance do, for nothing.
    bodyLimit: MAX_BODY_BYTES,
  });

  const allowed = new Set(deps.allowedOrigins);

  /**
   * Methods this server actually serves, collected as routes register.
   *
   * Derived rather than listed. A hand-written list went stale the moment
   * `DELETE /pick` was added: the route worked, `curl` proved it, and every
   * browser was refused at the preflight with a message naming CORS rather than
   * the route. A list that cannot fall behind the routes is the only version of
   * this worth having.
   */
  const methods = new Set<string>(['OPTIONS']);
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      methods.add(method);
    }
  });

  /**
   * Cross-origin access (§5, §47).
   *
   * The origin is echoed back rather than answered with `*`, and `Vary: Origin`
   * goes with it — without that header a shared cache can serve one origin's
   * allowed response to another origin, which turns a correct check into an
   * incorrect one at the cache layer.
   *
   * An origin that is not on the list simply gets no CORS headers. The request
   * still succeeds; the browser is the one that refuses to hand the body to the
   * page, which is exactly where that decision belongs.
   */
  app.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin !== undefined && allowed.has(origin)) {
      void reply.header('access-control-allow-origin', origin);
      void reply.header('vary', 'Origin');
    }

    if (request.method !== 'OPTIONS') {
      done();
      return;
    }

    // Preflight. A PUT carrying JSON and an authorization header triggers one,
    // so a pick cannot be submitted from a browser without answering it.
    void reply.header('access-control-allow-methods', [...methods].sort().join(', '));
    void reply.header('access-control-allow-headers', 'content-type, authorization');
    void reply.header('access-control-max-age', '600');
    void reply.code(204).send();
  });

  const send = (reply: FastifyReply, failure: ErrorResponse): FastifyReply =>
    reply.code(failure.status).send(failure.body);

  /**
   * `GET /v1/roster` (§47.1, §4.1, §4.2).
   *
   * Constant, and served rather than compiled into every client. §4.1 fixes the
   * ten and §4.2 the reserves; a client with its own copy would keep showing an
   * old roster after a swap, and the swap is the whole reason the reserve list
   * exists.
   */
  app.get('/v1/roster', () =>
    rosterSchema.parse({ active: [...ACTIVE_TICKERS], reserve: [...RESERVE_TICKERS] }),
  );

  /**
   * `GET /v1/status` (§47.1).
   *
   * The protocol version travels with it so a client can tell a server it does
   * not understand from one that is merely down — §70.7 has the receiver reject
   * an unknown version, and this is where a client can find out before it
   * subscribes rather than after.
   */
  app.get('/v1/status', () => {
    const round = deps.currentRound();
    return serviceStatusSchema.parse({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      round: round === null ? null : { roundId: round.roundId, state: round.state },
    });
  });

  /**
   * Liveness (§59.3).
   *
   * Is this process running. Nothing else — deliberately. An orchestrator
   * restarts a container whose liveness probe fails, so a liveness check that
   * fails when a *dependency* is down turns one outage into a restart loop that
   * makes it worse.
   */
  app.get('/v1/health', () => {
    const round = deps.currentRound();
    return {
      status: 'ok',
      round: round === null ? null : { roundId: round.roundId, state: round.state },
    };
  });

  /**
   * Readiness (§59.3).
   *
   * Should this instance be sent traffic. It should not before a round has
   * loaded: §47.1's whole surface answers about a round, so an instance without
   * one serves `404` to every request a spectator makes — and §5 makes
   * spectating the normal case. A load balancer holding it out of rotation for
   * the few seconds that takes is the difference between a rolling deploy
   * nobody notices and one that empties the world for everyone.
   *
   * `503` rather than a `200` with a flag in the body, because that is the
   * status every load balancer already reads without being configured to.
   */
  app.get('/v1/ready', (_request, reply) => {
    const round = deps.currentRound();
    if (round === null) {
      return reply.code(503).send({ status: 'starting', reason: 'no round loaded yet' });
    }
    return reply.send({
      status: 'ready',
      round: { roundId: round.roundId, state: round.state },
    });
  });

  /**
   * `POST /v1/auth/challenge` (§69.4, §45.2).
   *
   * Issued for whatever address asks, without checking that it exists or has
   * ever played: an unknown address is what a first sign-in looks like, and
   * refusing here would tell an anonymous caller which wallets have accounts.
   *
   * The chain is checked before anything is issued. §45.2 requires a signature
   * to match chain policy, and the useful moment to say so is before somebody
   * approves a wallet prompt rather than after.
   */
  app.post('/v1/auth/challenge', async (request, reply) => {
    const id = correlationId();
    const parsed = authChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return send(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'unknown', id));
    }
    if (parsed.data.chainId !== deps.auth.chainId) {
      return send(reply, wrongChain(deps.auth.chainId, id));
    }

    const challenge = await deps.auth.challenge(parsed.data.wallet);
    return reply.code(201).send(
      authChallengeSchema.parse({
        nonce: challenge.nonce,
        message: challenge.message,
        expiresAt: challenge.expiresAt,
        statement: CHALLENGE_STATEMENT,
        chainId: deps.auth.chainId,
      }),
    );
  });

  /**
   * `POST /v1/auth/verify` (§69.5, §45.2).
   *
   * One refusal for every way this can fail. An expired challenge, one already
   * used, one that never existed and a signature from the wrong wallet are four
   * different facts, and telling them apart helps exactly one kind of caller:
   * somebody working through nonces that are not theirs. The player's next step
   * is the same in all four.
   *
   * The token is in this response and nowhere else. The server keeps a
   * fingerprint, so it cannot be re-sent — a client that loses it signs in
   * again, which is the correct outcome.
   */
  app.post('/v1/auth/verify', async (request, reply) => {
    const id = correlationId();
    const parsed = authVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return send(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'unknown', id));
    }

    const result = await deps.auth.verify(parsed.data.nonce, parsed.data.signature);
    // The wallet in the body is checked against the one that signed rather than
    // trusted: a client that asks to sign in as one address and proves another
    // is confused at best, and this is the cheapest place to notice.
    if (!result.ok || result.session.wallet !== parsed.data.wallet) {
      return send(reply, signInRefused(id));
    }

    return reply.code(201).send(
      authSessionSchema.parse({
        token: result.session.token,
        wallet: result.session.wallet,
        expiresAt: result.session.expiresAt,
      }),
    );
  });

  /**
   * `GET /v1/auth/session` (§45.2).
   *
   * What this token is, for a client that has one in storage and does not know
   * whether it still works — after a reload, or after a session expired while
   * the tab was in the background.
   */
  app.get('/v1/auth/session', async (request, reply) => {
    const id = correlationId();
    const session = await deps.auth.session(bearer(request.headers.authorization) ?? '');
    if (session === null) {
      return send(reply, unauthenticated(id));
    }
    return reply.send(
      authSessionInfoSchema.parse({ wallet: session.wallet, expiresAt: session.expiresAt }),
    );
  });

  /**
   * `DELETE /v1/auth/session` (§45.2 revocation).
   *
   * Signing out. Answers `204` whether or not the token was live, because the
   * caller's intent — that this token stops working — is satisfied either way,
   * and an answer that distinguished the two would only help somebody holding a
   * token that is not theirs.
   */
  app.delete('/v1/auth/session', async (request, reply) => {
    const token = bearer(request.headers.authorization);
    if (token !== null) {
      await deps.auth.revoke(token);
    }
    return reply.code(204).send();
  });

  /**
   * `POST /v1/auth/session/rotate` (§45.2 session rotation).
   *
   * A fresh token with a fresh expiry, the old one revoked. This is how a long
   * visit stays signed in without the session token itself being long-lived:
   * the credential in flight is always young, so a copy taken from a machine
   * hours ago is already dead.
   */
  app.post('/v1/auth/session/rotate', async (request, reply) => {
    const id = correlationId();
    const token = bearer(request.headers.authorization);
    const rotated = token === null ? null : await deps.auth.rotate(token);
    if (rotated === null) {
      return send(reply, unauthenticated(id));
    }
    return reply.code(201).send(
      authSessionSchema.parse({
        token: rotated.token,
        wallet: rotated.wallet,
        expiresAt: rotated.expiresAt,
      }),
    );
  });

  /**
   * `GET /v1/rounds/current` (§47.1, §27.4).
   *
   * The response is parsed through `currentRoundSchema` on the way out. That
   * schema is `.strict()` and has no score field, so a live score cannot leave
   * this process even if some future refactor puts one in scope — §47.1 turns
   * from a review item into a failing parse.
   */
  const sectors = sectorIds();

  app.get('/v1/rounds/current', (_request, reply) => {
    const round = deps.currentRound();
    if (round === null) {
      return send(reply, roundNotFound('current', correlationId()));
    }

    const body = currentRoundSchema.parse({
      roundId: round.roundId,
      state: round.state,
      // `serverTime` is stamped now, not carried from the round.
      // `CanonicalClock` defines it as "server time at the moment this payload
      // was produced", and the round's copy was taken when the round opened —
      // up to ten minutes ago. A client computing its clock offset from that
      // would project every countdown ten minutes wrong, which is the one thing
      // §23.5 exists to prevent.
      clock: { ...round.clock, serverTime: deps.now() },
      // The sector a battle occupies is its slot in the round (§38.4): five
      // fixed, neutral sectors, reused every round. It is positional rather
      // than stored, so it is derived here rather than duplicated onto setup.
      battles: round.battles.map((battle, slot) => ({
        battleId: battle.setup.battleId,
        roundId: round.roundId,
        sectorId: sectors[slot] ?? sectors[0],
        left: battle.setup.left,
        right: battle.setup.right,
        leftIntel: battle.setup.leftIntel,
        rightIntel: battle.setup.rightIntel,
        state: battle.state,
      })),
    });
    return reply.send(body);
  });

  /**
   * `PUT /v1/rounds/:roundId/pick` (§47.5, §4.2).
   *
   * Every rejection below names what was wrong rather than returning one
   * "invalid" for all of them. A player who backed the right battle and
   * mistyped a ticker is in a different situation from one who missed the lock,
   * and only one of them needs telling that no card charge was spent.
   */
  app.put('/v1/rounds/:roundId/pick', async (request, reply) => {
    const id = correlationId();

    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(id));
    }

    const parsed = pickRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return send(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'unknown', id));
    }
    const pick = parsed.data;

    const round = deps.currentRound();
    const { roundId } = request.params as { roundId: string };
    if (round?.roundId !== roundId || pick.roundId !== roundId) {
      return send(reply, roundNotFound(roundId, id));
    }

    // The server decides whether picks are open, from the same function the
    // orchestrator uses (§72.4). A stored flag would be a second answer to a
    // question that already has one.
    const action = nextRoundAction(round, deps.now(), deps.config.finalization.maxWait);
    if (action.kind !== 'ACCEPT_PICKS') {
      return send(reply, picksClosed(id));
    }

    const battle = round.battles.find((candidate) => candidate.setup.battleId === pick.battleId);
    if (battle === undefined) {
      return send(reply, battleNotInRound(pick.battleId, id));
    }
    if (pick.backedTicker !== battle.setup.left && pick.backedTicker !== battle.setup.right) {
      return send(reply, tickerNotInBattle(pick.backedTicker, id));
    }
    if (pick.cardDecision === 'USE' && !canDeploy(await deps.cards.cardOf(wallet))) {
      return send(reply, noCardToUse(id));
    }

    // §4.2 is one pick per wallet per round, and §27.6 allows changing it until
    // lock — so an existing pick in *this* battle is a change, and one in a
    // different battle is also a change. Only a second concurrent identity
    // would be a conflict, which cannot happen with one wallet.
    const existing = await deps.picks.find(toRoundId(roundId), wallet);
    if (existing !== null && existing.clientRequestId === pick.clientRequestId) {
      // A retry of the same request. Idempotent by §66.6.
      return reply.code(200).send(pickResponseSchema.parse({ recorded: true, replayed: true }));
    }

    const result = await lockedAs(
      deps.picks.submit({
        wallet,
        roundId: toRoundId(pick.roundId),
        battleId: toBattleId(pick.battleId),
        backedTicker: pick.backedTicker,
        cardDecision: pick.cardDecision,
        receivedAt: deps.now(),
        clientRequestId: toClientRequestId(pick.clientRequestId),
      }),
    );
    if (result === LOCKED) {
      return send(reply, picksClosed(id));
    }

    // Parsed on the way out, like the round is. §66.2 asks for explicit schemas
    // on payloads, and a response nobody validates is the half of the contract
    // that drifts first.
    return reply.code(result.replayed ? 200 : 201).send(
      pickResponseSchema.parse({
        recorded: true,
        replayed: result.replayed,
        changed: existing !== null,
      }),
    );
  });

  /** `GET /v1/rounds/:roundId/pick` — what this wallet currently backs. */
  app.get('/v1/rounds/:roundId/pick', async (request, reply) => {
    const id = correlationId();
    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(id));
    }

    const { roundId } = request.params as { roundId: string };
    const existing = await deps.picks.find(toRoundId(roundId), wallet);
    if (existing === null) {
      return reply.code(200).send(myPickSchema.parse({ pick: null }));
    }

    return reply.code(200).send(
      myPickSchema.parse({
        pick: {
          battleId: existing.battleId,
          backedTicker: existing.backedTicker,
          cardDecision: existing.cardDecision,
        },
      }),
    );
  });

  /**
   * `DELETE /v1/rounds/:roundId/pick` (§47.5).
   *
   * Withdrawing is a mutation, so it obeys the same lock the submission does:
   * §22 allows changes only while `PICK_OPEN`, and a wallet that could withdraw
   * after lock would escape a loss it had already entered.
   *
   * Withdrawing a pick that is not there succeeds. §110.5 wants an answer that
   * says what happened, and "there was nothing to withdraw" is not a failure —
   * a client retrying a withdrawal it never saw succeed must not be told it did
   * something wrong.
   */
  app.delete('/v1/rounds/:roundId/pick', async (request, reply) => {
    const id = correlationId();

    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(id));
    }

    const round = deps.currentRound();
    const { roundId } = request.params as { roundId: string };
    if (round?.roundId !== roundId) {
      return send(reply, roundNotFound(roundId, id));
    }

    const action = nextRoundAction(round, deps.now(), deps.config.finalization.maxWait);
    if (action.kind !== 'ACCEPT_PICKS') {
      return send(reply, picksClosed(id));
    }

    const withdrawn = await lockedAs(deps.picks.withdraw(toRoundId(roundId), wallet));
    if (withdrawn === LOCKED) {
      return send(reply, picksClosed(id));
    }
    return reply.code(200).send({ withdrawn });
  });

  /**
   * `PUT /v1/rounds/:roundId/card-decision` (§47.6, §40.7).
   *
   * Separate from the pick because the two decisions happen in sequence — a
   * side first, then USE or SAVE — and re-sending the whole pick to change the
   * second would let a stale battle id overwrite the first.
   *
   * `USE` only *arms* the card. §47.6 consumes the use atomically when the
   * round enters lock, which is the engine's job at `lockRound`; nothing here
   * spends anything, so a player who changes their mind before lock has spent
   * nothing (§40.7).
   */
  app.put('/v1/rounds/:roundId/card-decision', async (request, reply) => {
    const id = correlationId();

    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(id));
    }

    const parsed = cardDecisionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return send(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'unknown', id));
    }

    const round = deps.currentRound();
    const { roundId } = request.params as { roundId: string };
    if (round?.roundId !== roundId || parsed.data.roundId !== roundId) {
      return send(reply, roundNotFound(roundId, id));
    }

    const action = nextRoundAction(round, deps.now(), deps.config.finalization.maxWait);
    if (action.kind !== 'ACCEPT_PICKS') {
      return send(reply, picksClosed(id));
    }

    if (parsed.data.decision === 'USE' && !canDeploy(await deps.cards.cardOf(wallet))) {
      return send(reply, noCardToUse(id));
    }

    const updated = await lockedAs(
      deps.picks.decideCard(toRoundId(roundId), wallet, parsed.data.decision, deps.now()),
    );
    if (updated === LOCKED) {
      return send(reply, picksClosed(id));
    }
    if (updated === null) {
      // Nothing to arm. A decision without a pick is not a smaller pick; §40.7
      // puts the card after the side, and saying so is more useful than
      // recording a decision the round will never read.
      return send(reply, noPickToDecide(id));
    }

    return reply.code(200).send({ cardDecision: updated.cardDecision });
  });

  /**
   * `GET /v1/profile` (§69.9, §34).
   *
   * The signed-in wallet's own record, and nobody else's: the wallet is the one
   * the session proves, never a parameter. A profile is personal, so it is
   * marked private — a shared cache that stored one would serve it to whoever
   * asked next.
   */
  app.get('/v1/profile', async (request, reply) => {
    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(correlationId()));
    }

    const [record, war, genesis] = await Promise.all([
      deps.playerRecords.recordOf(wallet),
      warHolding(deps.warBalanceOf, wallet),
      genesisHolding(deps, wallet),
    ]);
    void reply.header('cache-control', 'private, no-store');
    return reply.send(profileSchema.parse({ ...record, holdings: { war, genesis } }));
  });

  /**
   * `GET /v1/rewards/claims` (§16.8, §17, §35.6).
   *
   * The signed-in wallet's published allocations, each with the proof the
   * contract takes, and whether it has been claimed as the contract says. A
   * claim is never sent from here: the player's own wallet sends it, to
   * themselves.
   */
  app.get('/v1/rewards/claims', async (request, reply) => {
    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(correlationId()));
    }
    void reply.header('cache-control', 'private, no-store');
    const rewards = deps.rewardClaims;
    if (rewards === undefined) {
      return reply.send(rewardClaimsSchema.parse({ status: 'UNPUBLISHED' }));
    }

    const claims = await rewards.claimsOf(wallet);
    const claimed = await Promise.all(
      claims.map((claim) => withinChainTimeout(rewards.hasClaimed(claim.distributionId, wallet))),
    );
    return reply.send(
      rewardClaimsSchema.parse({
        status: 'READ',
        chainId: rewards.chainId,
        distributor: rewards.distributor,
        decimals: rewards.decimals,
        claims: claims.map((claim, index) => ({
          distributionId: claim.distributionId.toString(),
          amount: claim.amount.toString(),
          proof: claim.proof,
          claimed: claimed[index] ?? null,
        })),
      }),
    );
  });

  /**
   * A Genesis read or request, answered (§47.4, §69.6).
   *
   * Private to the wallet, like a profile. A chain that did not answer is a
   * `503` that says nothing was decided; anything else that throws is a fault
   * and is left to be one.
   */
  const answerGenesis = async (
    reply: FastifyReply,
    work: () => Promise<GenesisStatus>,
    options: { readonly noneIsNotFound?: boolean } = {},
  ): Promise<FastifyReply> => {
    void reply.header('cache-control', 'private, no-store');
    let status: GenesisStatus;
    try {
      status = await work();
    } catch (error: unknown) {
      if (error instanceof GenesisChainError) {
        return send(reply, chainUnavailable(correlationId()));
      }
      throw error;
    }
    if (options.noneIsNotFound === true && status.kind === 'NONE') {
      return send(reply, genesisRequestNotFound(correlationId()));
    }
    return reply.send(genesisStatusSchema.parse(genesisBody(status)));
  };

  /**
   * `GET /v1/genesis` — where this wallet's Genesis claim has got to (§69.6).
   *
   * Finishes the claim when its block has been finalized since it was last
   * asked, so a client waiting on `PENDING_FINALITY` only has to ask again.
   */
  app.get('/v1/genesis', async (request, reply) => {
    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(correlationId()));
    }
    const genesis = deps.genesis;
    if (genesis === undefined) {
      void reply.header('cache-control', 'private, no-store');
      return reply.send(genesisStatusSchema.parse({ status: 'UNPUBLISHED' }));
    }
    return answerGenesis(reply, () => genesis.status(wallet));
  });

  /**
   * `POST /v1/genesis/request` (§69.6).
   *
   * Idempotent per wallet: the wallet's one request, however many times it is
   * sent. No body — the wallet is the session's, and nothing else is chosen.
   */
  app.post('/v1/genesis/request', async (request, reply) => {
    const wallet = await deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(correlationId()));
    }
    const genesis = deps.genesis;
    if (genesis === undefined) {
      return send(reply, genesisUnavailable(correlationId()));
    }
    return answerGenesis(reply, () => genesis.request(wallet));
  });

  /**
   * `GET /v1/genesis/:requestId` and `POST /v1/genesis/:requestId/finalize` (§47.4).
   *
   * The same answer by request id. Only the wallet's own request is found — a
   * request id is derived from its wallet, so any other is not this wallet's to
   * read. Finalizing is what reading already does, so the two are one handler.
   */
  const byRequestId = async (
    authorization: string | undefined,
    requestId: string,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const wallet = await deps.walletOf(authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(correlationId()));
    }
    const genesis = deps.genesis;
    if (genesis === undefined) {
      return send(reply, genesisUnavailable(correlationId()));
    }
    if (requestId !== genesisRequestId(wallet)) {
      return send(reply, genesisRequestNotFound(correlationId()));
    }
    return answerGenesis(reply, () => genesis.status(wallet), { noneIsNotFound: true });
  };
  app.get<{ Params: { requestId: string } }>('/v1/genesis/:requestId', (request, reply) =>
    byRequestId(request.headers.authorization, request.params.requestId, reply),
  );
  app.post<{ Params: { requestId: string } }>('/v1/genesis/:requestId/finalize', (request, reply) =>
    byRequestId(request.headers.authorization, request.params.requestId, reply),
  );

  /**
   * `GET /v1/battles/:battleId/result` (§47.1, §27.8).
   *
   * Public, because a result is public. §12.6 hides the exact score only while
   * the battle is live, and this can only answer once it is not — a battle with
   * no result yet is not found rather than answered with an empty one.
   *
   * It exists because a client that learns results only from a live event
   * cannot show one after a reload, and the result screen is reached *after*
   * the battle it describes has ended.
   */
  app.get('/v1/battles/:battleId/result', async (request, reply) => {
    const { battleId } = request.params as { battleId: string };
    const result = await deps.finalizedResult(battleId);
    if (result === null) {
      return send(reply, resultNotFound(battleId, correlationId()));
    }
    return reply.send(battleResultSchema.parse(result));
  });

  return app;
}
