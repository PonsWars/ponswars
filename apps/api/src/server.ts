import {
  nextRoundAction,
  sectorIds,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import {
  cardDecisionRequestSchema,
  battleResultSchema,
  currentRoundSchema,
  myPickSchema,
  pickRequestSchema,
  pickResponseSchema,
} from '@ponswars/schemas';
import {
  battleId as toBattleId,
  clientRequestId as toClientRequestId,
  roundId as toRoundId,
  type FinalizedBattleResult,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  battleNotInRound,
  invalidRequest,
  noPickToDecide,
  resultNotFound,
  picksClosed,
  roundNotFound,
  tickerNotInBattle,
  unauthenticated,
  type ErrorResponse,
} from './errors.js';
import type { PickStore } from './pick-store.js';

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
  readonly picks: PickStore;
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
   */
  readonly walletOf: (authorization: string | undefined) => WalletAddress | null;
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
   */
  readonly finalizedResult: (battleId: string) => FinalizedBattleResult | null;
}

/** Correlation id for one request, so an error can be traced (§110.5). */
function correlationId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

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

  app.get('/v1/health', () => {
    const round = deps.currentRound();
    return {
      status: 'ok',
      round: round === null ? null : { roundId: round.roundId, state: round.state },
    };
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
  app.put('/v1/rounds/:roundId/pick', (request, reply) => {
    const id = correlationId();

    const wallet = deps.walletOf(request.headers.authorization);
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

    // §4.2 is one pick per wallet per round, and §27.6 allows changing it until
    // lock — so an existing pick in *this* battle is a change, and one in a
    // different battle is also a change. Only a second concurrent identity
    // would be a conflict, which cannot happen with one wallet.
    const existing = deps.picks.find(toRoundId(roundId), wallet);
    if (existing !== null && existing.clientRequestId === pick.clientRequestId) {
      // A retry of the same request. Idempotent by §66.6.
      return reply.code(200).send(pickResponseSchema.parse({ recorded: true, replayed: true }));
    }

    const result = deps.picks.submit({
      wallet,
      roundId: toRoundId(pick.roundId),
      battleId: toBattleId(pick.battleId),
      backedTicker: pick.backedTicker,
      cardDecision: pick.cardDecision,
      receivedAt: deps.now(),
      clientRequestId: toClientRequestId(pick.clientRequestId),
    });

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
  app.get('/v1/rounds/:roundId/pick', (request, reply) => {
    const id = correlationId();
    const wallet = deps.walletOf(request.headers.authorization);
    if (wallet === null) {
      return send(reply, unauthenticated(id));
    }

    const { roundId } = request.params as { roundId: string };
    const existing = deps.picks.find(toRoundId(roundId), wallet);
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
  app.delete('/v1/rounds/:roundId/pick', (request, reply) => {
    const id = correlationId();

    const wallet = deps.walletOf(request.headers.authorization);
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

    return reply.code(200).send({ withdrawn: deps.picks.withdraw(toRoundId(roundId), wallet) });
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
  app.put('/v1/rounds/:roundId/card-decision', (request, reply) => {
    const id = correlationId();

    const wallet = deps.walletOf(request.headers.authorization);
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

    const updated = deps.picks.decideCard(
      toRoundId(roundId),
      wallet,
      parsed.data.decision,
      deps.now(),
    );
    if (updated === null) {
      // Nothing to arm. A decision without a pick is not a smaller pick; §40.7
      // puts the card after the side, and saying so is more useful than
      // recording a decision the round will never read.
      return send(reply, noPickToDecide(id));
    }

    return reply.code(200).send({ cardDecision: updated.cardDecision });
  });

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
  app.get('/v1/battles/:battleId/result', (request, reply) => {
    const { battleId } = request.params as { battleId: string };
    const result = deps.finalizedResult(battleId);
    if (result === null) {
      return send(reply, resultNotFound(battleId, correlationId()));
    }
    return reply.send(battleResultSchema.parse(result));
  });

  return app;
}
