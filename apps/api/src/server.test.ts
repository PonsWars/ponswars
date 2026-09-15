import { AuthService, MemoryAuthStore, type AuthPolicy } from '@ponswars/auth';
import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import {
  RATIO_SCALE,
  clockForRound,
  roundIdFor,
  type ConfidenceCalibration,
  type ConfidenceLookback,
} from '@ponswars/battle-math';
import {
  apiErrorSchema,
  authChallengeSchema,
  authSessionInfoSchema,
  authSessionSchema,
  battleResultSchema,
  currentRoundSchema,
  genesisStatusSchema,
  profileSchema,
  rewardClaimsSchema,
  secretClaimSchema,
  rosterSchema,
  serviceStatusSchema,
} from '@ponswars/schemas';
import {
  ACTIVE_TICKERS,
  baseUnits,
  milliseconds,
  tokenDecimals,
  roundId as toRoundId,
  utcTimestamp,
  type FinalizedBattleResult,
  walletAddress,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { playerRecord, type SettledPick } from '@ponswars/player-service';
import {
  ENTROPY_TARGET_DISTANCE,
  GenesisFlow,
  genesisRequestId,
  MemoryGenesisRepository,
} from '@ponswars/genesis-service';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCardHoldings, type CardHolding } from '@ponswars/round-service';
import { PickStore } from './pick-store.js';
import { buildServer, CHAIN_READ_TIMEOUT_MS, MAX_BODY_BYTES, type ServerDeps } from './server.js';

/**
 * The HTTP surface, exercised as HTTP.
 *
 * `inject` runs a real request through routing, parsing, validation and
 * serialisation without opening a port — so these assert what a client would
 * actually receive, not what a handler returns.
 */

const EPOCH = utcTimestamp(1_800_000_000_000);
const CLOCK = clockForRound(EPOCH, 0, EPOCH);
const ROUND_ID = roundIdFor(0);
const WALLET = walletAddress(`0x${'1'.repeat(40)}`);

const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 20n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

const CONFIDENCE_CALIBRATION: ConfidenceCalibration = {
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: (RATIO_SCALE * 13n) / 10n, weak: (RATIO_SCALE * 7n) / 10n },
  ponsActivity: { high: 40n, medium: 15n },
  momentumStability: { stable: 2, mixed: 5 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

/** Every ticker looking identical, so every matchup opens EVEN. */
const CONFIDENCE = {
  lookback: Object.fromEntries(
    ACTIVE_TICKERS.map((ticker) => [
      ticker,
      {
        windowReturn: 0n,
        volatility: RATIO_SCALE,
        relativeVolume: RATIO_SCALE,
        qualifiedPonsActivity: 20n,
        subWindowReturns: [10n, 10n, 10n],
      } satisfies ConfidenceLookback,
    ]),
  ),
  calibration: CONFIDENCE_CALIBRATION,
};

function openRound(): RoundEngineState {
  const round = createRound({
    roundId: toRoundId(ROUND_ID),
    roundIndex: 0,
    clock: CLOCK,
    baseSeedHex: `0x${'5c'.repeat(32)}`,
    recentRounds: [],
    confidence: CONFIDENCE,
  });
  return { ...round, state: 'PICK_OPEN' };
}

const ALLOWED_ORIGIN = 'https://play.example.test';

/**
 * Sign-in policy for these tests.
 *
 * A real `AuthService` over an in-memory store rather than a stub, so the
 * routes are exercised against the thing that will answer them — including the
 * parts that refuse.
 */
const AUTH_POLICY: AuthPolicy = {
  challengeTtlMs: 300_000,
  sessionTtlMs: 3_600_000,
  domain: 'play.example.test',
  uri: ALLOWED_ORIGIN,
  chainId: 4663,
};

/** Finalized results the server can answer for, seeded per test. */
let finalized: Map<string, FinalizedBattleResult>;

let round: RoundEngineState;
let picks: PickStore;
let auth: AuthService;
let now: UtcTimestamp;
let app: FastifyInstance;
/** Wallets the record source was asked about, so a test can see whose was read. */
let asked: WalletAddress[] = [];
/** What the record source derives each record from. */
let settledPicks: SettledPick[] = [];
/**
 * Who holds a card. The signed-in wallet holds one with charges left unless a
 * test takes it away, so the card flow is exercised as a holder meets it.
 */
let holdings: Map<WalletAddress, CardHolding>;
/** What `app` was built from, for a test that needs the same server with one thing changed. */
let serverDeps: ServerDeps;

beforeEach(() => {
  round = openRound();
  asked = [];
  settledPicks = [];
  finalized = new Map();
  auth = new AuthService({ store: new MemoryAuthStore(), policy: AUTH_POLICY, now: () => now });
  holdings = new Map([
    [WALLET, { cardInstanceId: 'card-1', cardType: 'BULL_RUN', remainingUses: 3 }],
  ]);
  const cards = new MemoryCardHoldings(holdings);
  picks = new PickStore(cards);
  now = utcTimestamp(EPOCH + 30_000);
  serverDeps = {
    currentRound: () => round,
    picks,
    config: CONFIG,
    allowedOrigins: [ALLOWED_ORIGIN],
    finalizedResult: (battleId) => Promise.resolve(finalized.get(battleId) ?? null),
    now: () => now,
    // Any bearer token is treated as that wallet. Signature verification is
    // §45.2 and belongs to the auth service; these tests are about the routes.
    walletOf: (authorization) => Promise.resolve(authorization === undefined ? null : WALLET),
    auth,
    cards,
    playerRecords: {
      recordOf: (who) => {
        asked.push(who);
        return Promise.resolve(
          playerRecord({ wallet: who, settled: settledPicks, windowWarPoints: 64, window: null }),
        );
      },
    },
  };
  app = buildServer(serverDeps);
});

const AUTH = { authorization: 'Bearer test' };
const pickUrl = (): string => `/v1/rounds/${ROUND_ID}/pick`;

function pickBody(overrides: Record<string, unknown> = {}) {
  const battle = round.battles[0];
  if (battle === undefined) {
    throw new Error('round has no battles');
  }
  return {
    roundId: ROUND_ID,
    battleId: battle.setup.battleId,
    backedTicker: battle.setup.left,
    cardDecision: 'SAVE',
    clientRequestId: 'req-0001',
    ...overrides,
  };
}

describe('GET /v1/rounds/current', () => {
  it('needs no wallet at all', async () => {
    // §5 keeps PonsWars fully watchable without connecting. Requiring auth to
    // watch would break the spectator promise the product is built on.
    const response = await app.inject({ method: 'GET', url: '/v1/rounds/current' });
    expect(response.statusCode).toBe(200);
  });

  it('returns a body that satisfies the published contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/rounds/current' });
    expect(() => currentRoundSchema.parse(response.json())).not.toThrow();
  });

  it('carries no score for anyone to read', async () => {
    // §47.1 forbids exposing the hidden live score. The schema is `.strict()`
    // and has no score field, so this asserts the wire rather than the type.
    const response = await app.inject({ method: 'GET', url: '/v1/rounds/current' });
    const body = response.body;
    expect(body).not.toContain('Score');
    expect(body).not.toContain('score');
  });

  it('lists all five battles with their sectors', async () => {
    const body = currentRoundSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/rounds/current' })).json(),
    );
    expect(body.battles).toHaveLength(5);
    expect(new Set(body.battles.map((battle) => battle.sectorId)).size).toBe(5);
  });

  it('opens the next round where this one ends, in a market that never shuts', async () => {
    const body = currentRoundSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/rounds/current' })).json(),
    );
    expect(body.nextRoundOpensAt).toBe(body.clock.battleEndAt);
  });

  it('names when the market reopens when it shuts before the next round', async () => {
    const reopensAt = utcTimestamp(round.clock.battleEndAt + 48 * 3_600_000);
    const closing = buildServer({ ...serverDeps, roundsOpenAt: () => reopensAt });

    const body = currentRoundSchema.parse(
      (await closing.inject({ method: 'GET', url: '/v1/rounds/current' })).json(),
    );
    expect(body.nextRoundOpensAt).toBe(reopensAt);

    await closing.close();
  });

  it('says the market is closed, and until when, rather than that no round exists', async () => {
    const reopensAt = utcTimestamp(now + 3_600_000);
    const closed = buildServer({
      ...serverDeps,
      currentRound: () => null,
      roundsOpenAt: (at) => (at < reopensAt ? reopensAt : at),
    });

    const response = await closed.inject({ method: 'GET', url: '/v1/rounds/current' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: 'MARKET_CLOSED',
      stateIsSafe: true,
      retryAt: reopensAt,
    });
    expect(response.json<{ message: string }>().message).toContain(
      new Date(reopensAt).toISOString(),
    );

    await closed.close();
  });
});

describe('PUT /v1/rounds/:roundId/pick', () => {
  it('records a pick during the phase', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody(),
    });
    expect(response.statusCode).toBe(201);
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);
  });

  it('refuses a request with no wallet', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      payload: pickBody(),
    });
    expect(response.statusCode).toBe(401);
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(0);
  });

  it('accepts a pick one millisecond before the lock', async () => {
    now = utcTimestamp(CLOCK.lockAt - 1);
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody(),
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses a pick at exactly the lock', async () => {
    // §72.4: the server decides whether a submission was in time, and the
    // boundary is `lockAt`. A client whose clock runs slow does not get to
    // argue past it.
    now = CLOCK.lockAt;
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(0);
  });

  it('tells a player whose pick missed the lock that nothing was spent', async () => {
    // §110.5 requires an error to say whether state is safe. This is the one
    // rejection where a player will assume they lost a card charge.
    now = CLOCK.lockAt;
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody({ cardDecision: 'USE' }),
    });
    const error = apiErrorSchema.parse(response.json());
    expect(error.stateIsSafe).toBe(true);
    expect(error.nextStep).toContain('no card charge was spent');
  });

  it('names the mistake rather than returning one generic rejection', async () => {
    const wrongBattle = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody({ battleId: 'not-a-battle-in-this-round' }),
    });
    expect(apiErrorSchema.parse(wrongBattle.json()).code).toBe('BATTLE_NOT_IN_ROUND');

    const wrongTicker = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody({
        backedTicker: ACTIVE_TICKERS.find(
          (ticker) =>
            ticker !== round.battles[0]?.setup.left && ticker !== round.battles[0]?.setup.right,
        ),
      }),
    });
    expect(apiErrorSchema.parse(wrongTicker.json()).code).toBe('TICKER_NOT_IN_BATTLE');
  });

  it('rejects a body that does not match the schema', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: { roundId: ROUND_ID },
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).code).toBe('INVALID_REQUEST');
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    // The request schema is `.strict()`. A client sending `timestamp` is trying
    // to tell the server when it picked, and §47.5 does not accept that.
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody({ timestamp: 123 }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a pick aimed at a different round', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/some-other-round/pick`,
      headers: AUTH,
      payload: pickBody(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('treats a repeated request id as the same pick, not a second one', async () => {
    // §66.6. A client that never saw its response must be able to retry, and a
    // naive API turns that retry into a second write.
    const body = pickBody();
    const first = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: body,
    });
    const retry = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: body,
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: true });
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);
  });

  it('allows a pick to be changed until the lock', async () => {
    // §27.6. A change is a replacement, not a second pick.
    const battle = round.battles[0];
    if (battle === undefined) throw new Error('round has no battles');

    await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody(),
    });
    const changed = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody({
        backedTicker: battle.setup.right,
        cardDecision: 'USE',
        clientRequestId: 'req-0002',
      }),
    });

    expect(changed.statusCode).toBe(201);
    expect(changed.json()).toMatchObject({ changed: true });
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);
    expect((await picks.find(toRoundId(ROUND_ID), WALLET))?.backedTicker).toBe(battle.setup.right);
  });
});

describe('the frozen pick set', () => {
  it('is what the engine locks, with USE becoming a deployment', async () => {
    // §40.7 makes SAVE the absence of a deployment rather than a second kind
    // of one, which is the only distinction the engine cares about.
    await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody({ cardDecision: 'USE' }),
    });

    const locked = await picks.lockedPicks(toRoundId(ROUND_ID));
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ wallet: WALLET, deployedCard: 'BULL_RUN' });
  });
});

describe('GET /v1/rounds/:roundId/pick', () => {
  it('reports nothing before a pick is made', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
    });
    expect(response.json()).toEqual({ pick: null });
  });

  it('reports the wallet’s own pick after one', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
      payload: pickBody(),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      headers: AUTH,
    });
    expect(response.json()).toMatchObject({ pick: { cardDecision: 'SAVE' } });
  });
});

describe('GET /v1/health', () => {
  it('reports the round it is serving', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.json()).toMatchObject({ status: 'ok', round: { state: 'PICK_OPEN' } });
  });
});

/** The same server before a round has loaded, which is how every one starts. */
function startingServer(): FastifyInstance {
  return buildServer({
    currentRound: () => null,
    picks,
    config: CONFIG,
    allowedOrigins: [ALLOWED_ORIGIN],
    finalizedResult: () => Promise.resolve(null),
    now: () => now,
    walletOf: () => Promise.resolve(null),
    auth,
    cards: new MemoryCardHoldings(),
    playerRecords: {
      recordOf: () =>
        Promise.reject(new Error('a starting server has no signed-in wallet to read')),
    },
  });
}

describe('GET /v1/ready', () => {
  it('is ready once a round is loaded', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', round: { state: 'PICK_OPEN' } });
  });

  it('refuses traffic before one is', async () => {
    // Every §47.1 route answers about a round, so an instance without one
    // serves 404 to every request a spectator makes — and §5 makes spectating
    // the normal case. Held out of rotation until it can answer.
    const starting = startingServer();

    const response = await starting.inject({ method: 'GET', url: '/v1/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'starting' });

    await starting.close();
  });

  it('is ready while it waits out a closed market, since that is the service working', async () => {
    const reopensAt = utcTimestamp(now + 3_600_000);
    const closed = buildServer({
      ...serverDeps,
      currentRound: () => null,
      roundsOpenAt: () => reopensAt,
    });

    const response = await closed.inject({ method: 'GET', url: '/v1/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', round: null, marketClosedUntil: reopensAt });

    await closed.close();
  });

  it('stays alive while it is not ready', async () => {
    // The distinction the two probes exist for. An orchestrator restarts a
    // container whose liveness fails, so if this reported the same thing as
    // readiness a slow start would become a restart loop.
    const starting = startingServer();

    expect((await starting.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);

    await starting.close();
  });
});

describe('the canonical clock', () => {
  it('stamps server time when the payload is produced, not when the round opened', async () => {
    // §23.5 and the type's own words: "server time at the moment this payload
    // was produced". The round's stored copy was taken at `pickOpenAt`, so
    // serving it unchanged made a client's clock offset the age of the round —
    // fourteen seconds into a pick phase, and up to ten minutes by the end.
    now = utcTimestamp(EPOCH + 240_000);
    const response = await app.inject({ method: 'GET', url: '/v1/rounds/current' });
    const body = currentRoundSchema.parse(response.json());

    expect(body.clock.serverTime).toBe(now);
    expect(body.clock.serverTime).not.toBe(body.clock.pickOpenAt);
    // The other four are the round's and must not move with the request.
    expect(body.clock.pickOpenAt).toBe(round.clock.pickOpenAt);
    expect(body.clock.lockAt).toBe(round.clock.lockAt);
    expect(body.clock.battleEndAt).toBe(round.clock.battleEndAt);
  });
});

describe('cross-origin access', () => {
  it('lets a listed browser origin read a round', async () => {
    // §5 makes spectating the normal case, and a spectator is a browser. Before
    // this the API sent no CORS headers at all, so no page could read it — the
    // request succeeded and the browser threw the body away.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rounds/current',
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers.vary).toBe('Origin');
  });

  it('answers a preflight for a pick', async () => {
    // A PUT carrying JSON and an authorization header is preflighted, so
    // without this a pick cannot be submitted from a browser at all.
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/rounds/round-0000000000/pick',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'PUT' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('advertises every method it actually serves', async () => {
    // The bug this exists for: the allowed-methods list was written by hand and
    // went stale the moment `DELETE /pick` was added. The route worked and
    // `curl` proved it, while every browser was refused at the preflight with a
    // message naming CORS rather than the route.
    const response = await app.inject({
      method: 'OPTIONS',
      url: pickUrl(),
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'DELETE' },
    });

    const advertised = String(response.headers['access-control-allow-methods']).split(', ');
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(advertised).toContain(method);
    }
  });

  it('gives an unlisted origin no permission, and no error either', async () => {
    // The request still succeeds; the browser is what refuses to hand the body
    // to the page. Answering with an error instead would tell an attacker which
    // origins are allowed.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rounds/current',
      headers: { origin: 'https://elsewhere.example.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard', async () => {
    // `*` would also hand any page on the internet the ability to make
    // authenticated requests on a visitor's behalf the moment credentials are
    // enabled, and that is not a change anyone would notice happening.
    for (const origin of [ALLOWED_ORIGIN, 'https://elsewhere.example.test']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/rounds/current',
        headers: { origin },
      });
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    }
  });
});

describe('DELETE /v1/rounds/:roundId/pick', () => {
  it('withdraws a pick during the phase', async () => {
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);

    const response = await app.inject({ method: 'DELETE', url: pickUrl(), headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ withdrawn: true });
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(0);
  });

  it('succeeds when there was nothing to withdraw', async () => {
    // §110.5: a client retrying a withdrawal it never saw succeed must not be
    // told it did something wrong. Both cases are success, and the body says
    // which one happened.
    const response = await app.inject({ method: 'DELETE', url: pickUrl(), headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ withdrawn: false });
  });

  it('refuses to withdraw after the lock', async () => {
    // §22 allows mutation only while PICK_OPEN. A wallet that could withdraw
    // after lock would escape a loss it had already entered.
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });
    now = utcTimestamp(EPOCH + 60_000);

    const response = await app.inject({ method: 'DELETE', url: pickUrl(), headers: AUTH });

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).code).toBe('PICKS_CLOSED');
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);
  });

  it('needs a wallet', async () => {
    expect((await app.inject({ method: 'DELETE', url: pickUrl() })).statusCode).toBe(401);
  });

  it('lets the same battle be picked again after a withdrawal', async () => {
    // The idempotency key goes with the pick. A wallet that picks, withdraws
    // and picks the same battle again is deciding again, not retrying — holding
    // the key would silently return the pick that was withdrawn.
    const body = pickBody();
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: body });
    await app.inject({ method: 'DELETE', url: pickUrl(), headers: AUTH });
    const again = await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: body });

    expect(again.statusCode).toBe(201);
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);
  });
});

describe('PUT /v1/rounds/:roundId/card-decision', () => {
  const decisionUrl = () => `/v1/rounds/${ROUND_ID}/card-decision`;
  const decisionBody = (decision: 'USE' | 'SAVE') => ({
    roundId: ROUND_ID,
    decision,
    clientRequestId: 'req-card-1',
  });

  it('arms a card on an existing pick', async () => {
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });

    const response = await app.inject({
      method: 'PUT',
      url: decisionUrl(),
      headers: AUTH,
      payload: decisionBody('USE'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cardDecision: 'USE' });
  });

  it('changes only the decision, never the battle', async () => {
    // §40.7 makes these two decisions in sequence, and re-sending the whole
    // pick to change the second would let a stale battle id overwrite the first.
    const battle = round.battles[0];
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });
    await app.inject({
      method: 'PUT',
      url: decisionUrl(),
      headers: AUTH,
      payload: decisionBody('USE'),
    });

    const stored = await picks.find(toRoundId(ROUND_ID), WALLET);
    expect(stored?.battleId).toBe(battle?.setup.battleId);
    expect(stored?.backedTicker).toBe(battle?.setup.left);
    expect(stored?.cardDecision).toBe('USE');
  });

  it('arms without spending anything', async () => {
    // §47.6 and §40.7: USE arms during PICK_OPEN and the use is consumed
    // atomically at lock. A player who changes their mind before lock has spent
    // nothing, so the engine must see a deployment only after locking.
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });
    await app.inject({
      method: 'PUT',
      url: decisionUrl(),
      headers: AUTH,
      payload: decisionBody('USE'),
    });
    await app.inject({
      method: 'PUT',
      url: decisionUrl(),
      headers: AUTH,
      payload: { ...decisionBody('SAVE'), clientRequestId: 'req-card-2' },
    });

    const locked = await picks.lockedPicks(toRoundId(ROUND_ID));
    expect(locked[0]?.deployedCard).toBeNull();
  });

  it('refuses a decision with no pick behind it', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: decisionUrl(),
      headers: AUTH,
      payload: decisionBody('USE'),
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).code).toBe('NO_PICK_TO_DECIDE');
  });

  it('refuses a decision after the lock', async () => {
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });
    now = utcTimestamp(EPOCH + 60_000);

    const response = await app.inject({
      method: 'PUT',
      url: decisionUrl(),
      headers: AUTH,
      payload: decisionBody('USE'),
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).code).toBe('PICKS_CLOSED');
  });
});

describe('GET /v1/battles/:battleId/result', () => {
  /** A finalized result shaped exactly as the engine produces one. */
  const resultFor = (battleId: string): FinalizedBattleResult =>
    ({
      battleId,
      roundId: ROUND_ID,
      left: 'NVDA',
      right: 'AAPL',
      winner: 'NVDA',
      leftScore: {
        priceMomentum: 24_342_750,
        relativeVolume: 16_852_475,
        ponsPower: 11_627_240,
        holderCardSupport: 5_000_000,
      },
      rightScore: {
        priceMomentum: 20_657_250,
        relativeVolume: 8_147_525,
        ponsPower: 8_372_760,
        holderCardSupport: 5_000_000,
      },
      victoryLabel: 'VICTORY',
      scoringEngineVersion: 'scoring-v1',
      finalizedAt: utcTimestamp(EPOCH + 600_000),
      evidenceHash: `0x${'ab'.repeat(24)}`,
    }) as FinalizedBattleResult;

  it('answers with the finalized result', async () => {
    // A client that learns results only from a live event cannot show one after
    // a reload, and the result screen is reached after the battle has ended.
    const battleId = round.battles[0]?.setup.battleId ?? '';
    finalized.set(battleId, resultFor(battleId));

    const response = await app.inject({ method: 'GET', url: `/v1/battles/${battleId}/result` });

    expect(response.statusCode).toBe(200);
    const body = battleResultSchema.parse(response.json());
    expect(body.winner).toBe('NVDA');
    expect(body.evidenceHash).toBe(`0x${'ab'.repeat(24)}`);
  });

  it('answers a result the chain decided, with the block that decided it (§12.7)', async () => {
    // The response schema is strict: before it knew the block hash, a
    // chain-decided result failed to serialise and the link answered 500.
    const battleId = round.battles[0]?.setup.battleId ?? '';
    const block = `0x${'cd'.repeat(32)}`;
    finalized.set(battleId, {
      ...resultFor(battleId),
      tiebreakStep: 'chainDerived',
      tiebreakBlockHash: block,
    });

    const response = await app.inject({ method: 'GET', url: `/v1/battles/${battleId}/result` });

    expect(response.statusCode).toBe(200);
    expect(battleResultSchema.parse(response.json()).tiebreakBlockHash).toBe(block);
  });

  it('needs no wallet', async () => {
    // §5: a result is public, and spectating is the normal case.
    const battleId = round.battles[0]?.setup.battleId ?? '';
    finalized.set(battleId, resultFor(battleId));

    expect(
      (await app.inject({ method: 'GET', url: `/v1/battles/${battleId}/result` })).statusCode,
    ).toBe(200);
  });

  it('gives a running battle the same answer as an unknown one', async () => {
    // §12.6 hides the exact score while a battle is live, and "still running"
    // is a small piece of the same information — distinguishing the two would
    // also let anyone enumerate battle ids.
    const live = await app.inject({
      method: 'GET',
      url: `/v1/battles/${round.battles[0]?.setup.battleId ?? ''}/result`,
    });
    const unknown = await app.inject({ method: 'GET', url: '/v1/battles/nope/result' });

    expect(live.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(apiErrorSchema.parse(live.json()).code).toBe(apiErrorSchema.parse(unknown.json()).code);
  });

  it('carries scores at engine scale, summing to one hundred points', async () => {
    // The scale that has been wrong here before: a component reading 24_342_750
    // is 24.3 points. Both halves together are always a hundred, and a response
    // where they were not would mean the two sides were scored separately.
    const battleId = round.battles[0]?.setup.battleId ?? '';
    finalized.set(battleId, resultFor(battleId));

    const body = battleResultSchema.parse(
      (await app.inject({ method: 'GET', url: `/v1/battles/${battleId}/result` })).json(),
    );
    const total = (breakdown: Record<string, number>): number =>
      Object.values(breakdown).reduce((sum, value) => sum + value, 0);

    expect(total(body.leftScore) + total(body.rightScore)).toBe(100 * 1_000_000);
  });
});

describe('GET /v1/roster', () => {
  it('lists the ten active factions and the reserves separately', async () => {
    // §4.1 fixes the ten; §4.2 makes a reserve a *pre-round* replacement, never
    // a mid-battle swap (§4.4). One flat list would make them look
    // interchangeable, which is the distinction that matters most.
    const response = await app.inject({ method: 'GET', url: '/v1/roster' });
    const body = rosterSchema.parse(response.json());

    expect(body.active).toHaveLength(10);
    expect(body.reserve.length).toBeGreaterThan(0);
    expect(body.active.some((ticker) => body.reserve.includes(ticker))).toBe(false);
  });

  it('needs no wallet', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/roster' })).statusCode).toBe(200);
  });
});

describe('GET /v1/status', () => {
  it('reports the round it is serving and the protocol it speaks', async () => {
    // The version is here so a client can tell a server it does not understand
    // from one that is down — §70.7's receiver rejects an unknown version, and
    // finding out before subscribing is better than after.
    const body = serviceStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/status' })).json(),
    );

    expect(body.status).toBe('ok');
    expect(body.round?.roundId).toBe(ROUND_ID);
    expect(body.protocolVersion).toBeGreaterThan(0);
  });

  it('carries nothing operational', async () => {
    // A public status endpoint that reported queue depths or worker counts
    // would be an operational surface on a public URL. The schema is strict, so
    // this stays a decision rather than a habit.
    const keys = Object.keys((await app.inject({ method: 'GET', url: '/v1/status' })).json());
    expect(keys.sort()).toEqual(['protocolVersion', 'round', 'status']);
  });
});

describe('signing in with a wallet', () => {
  // A real key signing through a real wallet implementation. These routes must
  // not be verified against a signature the same code path produced.
  const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const SIGNER = walletAddress(account.address);
  const IMPOSTOR = privateKeyToAccount(`0x${'55'.repeat(32)}`);

  async function challenge(): Promise<{ nonce: string; message: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenge',
      payload: { wallet: SIGNER, chainId: AUTH_POLICY.chainId },
    });
    const body = authChallengeSchema.parse(response.json());
    return { nonce: body.nonce, message: body.message };
  }

  async function session(): Promise<string> {
    const { nonce, message } = await challenge();
    const signature = await account.signMessage({ message });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { wallet: SIGNER, nonce, signature },
    });
    return authSessionSchema.parse(response.json()).token;
  }

  it('hands back a message the wallet can display', async () => {
    const { message } = await challenge();

    // §110: somebody about to approve a wallet prompt should be told what it
    // is, and — the part people get wrong — what it is not.
    expect(message).toContain('play.example.test');
    expect(message).toContain('not a transaction');
  });

  it('refuses a wallet on another chain before anyone signs anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenge',
      payload: { wallet: SIGNER, chainId: AUTH_POLICY.chainId + 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).code).toBe('WRONG_CHAIN');
  });

  it('turns a signature into a session', async () => {
    const { nonce, message } = await challenge();
    const signature = await account.signMessage({ message });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { wallet: SIGNER, nonce, signature },
    });

    expect(response.statusCode).toBe(201);
    expect(authSessionSchema.parse(response.json()).wallet).toBe(SIGNER);
  });

  it('refuses the same signature twice', async () => {
    const { nonce, message } = await challenge();
    const signature = await account.signMessage({ message });
    const payload = { wallet: SIGNER, nonce, signature };
    await app.inject({ method: 'POST', url: '/v1/auth/verify', payload });

    const replayed = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload });

    expect(replayed.statusCode).toBe(401);
    expect(apiErrorSchema.parse(replayed.json()).code).toBe('SIGN_IN_REFUSED');
  });

  it('refuses a signature that proves a different wallet', async () => {
    const { nonce, message } = await challenge();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { wallet: SIGNER, nonce, signature: await IMPOSTOR.signMessage({ message }) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('says the same thing however the sign-in failed', async () => {
    // Four different facts, one answer. Telling them apart helps exactly one
    // kind of caller, and it is not the player.
    const { nonce, message } = await challenge();
    const wrong = await IMPOSTOR.signMessage({ message });

    const unknownNonce = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { wallet: SIGNER, nonce: '0'.repeat(32), signature: wrong },
    });
    const badSignature = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { wallet: SIGNER, nonce, signature: wrong },
    });

    expect(unknownNonce.json()).toMatchObject({ code: 'SIGN_IN_REFUSED' });
    expect(badSignature.json()).toMatchObject({ code: 'SIGN_IN_REFUSED' });
  });

  it('tells a client what its token is', async () => {
    const token = await session();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(authSessionInfoSchema.parse(response.json()).wallet).toBe(SIGNER);
  });

  it('does not answer for a token nobody issued', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('ends a session on request, and again without complaint', async () => {
    const token = await session();
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers });
    const second = await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers });
    const after = await app.inject({ method: 'GET', url: '/v1/auth/session', headers });

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(after.statusCode).toBe(401);
  });

  it('rotates a session into a new token and retires the old one', async () => {
    const token = await session();
    const headers = { authorization: `Bearer ${token}` };

    const rotated = await app.inject({ method: 'POST', url: '/v1/auth/session/rotate', headers });
    const next = authSessionSchema.parse(rotated.json());
    const withOld = await app.inject({ method: 'GET', url: '/v1/auth/session', headers });
    const withNew = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: `Bearer ${next.token}` },
    });

    expect(next.token).not.toBe(token);
    expect(withOld.statusCode).toBe(401);
    expect(withNew.statusCode).toBe(200);
  });

  it('will not rotate what is not a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/session/rotate',
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('ignores an Authorization header that is not a bearer token', async () => {
    // Not a token to try anyway. Hashing whatever was there and looking it up
    // cannot succeed, but does turn a malformed header into a database query.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: 'Basic YWxpY2U6c2VjcmV0' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('lets a browser reach the whole flow', async () => {
    // Every method these routes add has to survive the preflight. The allowed
    // list is derived from the routes, and this is what keeps that true.
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/session',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'DELETE' },
    });

    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
  });
});

describe('a pick write that lands after the picks froze', () => {
  // The route checks the phase from the clock, and the loop freezes the picks a
  // moment later — two instants a request can fall between. The store refuses
  // the write (§22); the player is owed the answer they would have had a second
  // later, not a server error.

  beforeEach(async () => {
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });
    // Frozen while the clock still says Pick Phase.
    await picks.lockedPicks(toRoundId(ROUND_ID));
  });

  it('refuses a new pick as closed', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: pickUrl(),
      headers: AUTH,
      payload: pickBody({
        clientRequestId: 'req-late',
        backedTicker: round.battles[0]?.setup.right,
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PICKS_CLOSED' });
  });

  it('refuses a withdrawal as closed', async () => {
    const response = await app.inject({ method: 'DELETE', url: pickUrl(), headers: AUTH });

    expect(response.statusCode).toBe(409);
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(1);
  });

  it('refuses a card decision as closed', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/card-decision`,
      headers: AUTH,
      payload: { roundId: ROUND_ID, decision: 'USE', clientRequestId: 'req-card-late' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PICKS_CLOSED' });
  });
});

describe('GET /v1/profile', () => {
  it('needs a signed-in wallet', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/profile' });

    expect(response.statusCode).toBe(401);
    expect(asked).toEqual([]);
  });

  it('reads the record of the wallet the session proves, and nobody else', async () => {
    // There is no wallet parameter to change. A profile route that took one
    // would be a way to read anyone's record.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/profile?wallet=0x0000000000000000000000000000000000000001',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(asked).toEqual([WALLET]);
    expect(profileSchema.parse(response.json()).wallet).toBe(WALLET);
  });

  it('answers with the published contract, and says the chain holdings are unpublished', async () => {
    const battle = round.battles[0];
    if (battle === undefined) {
      throw new Error('round has no battles');
    }
    settledPicks = [
      {
        roundId: round.roundId,
        battleId: battle.setup.battleId,
        left: battle.setup.left,
        right: battle.setup.right,
        backed: battle.setup.left,
        cardDeployed: true,
        settledAt: round.clock.battleEndAt,
        warPoints: 12,
        settlement: { kind: 'DECIDED', winner: battle.setup.left, winnerConfidence: 'EVEN' },
      },
    ];

    const body = profileSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/profile', headers: AUTH })).json(),
    );

    expect(body.lifetime).toMatchObject({
      battles: 1,
      wins: 1,
      cardAssistedWins: 1,
      warPoints: 12,
    });
    expect(body.currentWindow).toMatchObject({ warPoints: 64, qualified: true, window: null });
    expect(body.holdings).toEqual({
      war: { status: 'UNPUBLISHED' },
      genesis: { status: 'UNPUBLISHED' },
    });
  });

  describe('the $WAR balance', () => {
    const withBalance = (warBalanceOf: ServerDeps['warBalanceOf']) =>
      buildServer({ ...serverDeps, ...(warBalanceOf === undefined ? {} : { warBalanceOf }) });
    const holdingsFrom = async (server: ReturnType<typeof buildServer>) =>
      profileSchema.parse(
        (await server.inject({ method: 'GET', url: '/v1/profile', headers: AUTH })).json(),
      ).holdings;

    it('is read for the signed-in wallet, in base units with its decimals', async () => {
      const read: WalletAddress[] = [];
      const server = withBalance((who) => {
        read.push(who);
        return Promise.resolve({ balance: 1_234_567_000_000_000_000_000_000n, decimals: 18 });
      });

      expect((await holdingsFrom(server)).war).toEqual({
        status: 'READ',
        balance: '1234567000000000000000000',
        decimals: 18,
      });
      expect(read).toEqual([WALLET]);
    });

    it('is unavailable, not zero, when the chain read fails', async () => {
      const server = withBalance(() => Promise.reject(new Error('503 from the RPC endpoint')));

      const response = await server.inject({ method: 'GET', url: '/v1/profile', headers: AUTH });

      expect(response.statusCode).toBe(200);
      expect(profileSchema.parse(response.json()).holdings.war).toEqual({ status: 'UNAVAILABLE' });
    });

    it('is unavailable when the chain is slow, and the record still arrives', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const server = withBalance(() => new Promise(() => undefined));
        const pending = server.inject({ method: 'GET', url: '/v1/profile', headers: AUTH });
        await vi.advanceTimersByTimeAsync(CHAIN_READ_TIMEOUT_MS);

        const body = profileSchema.parse((await pending).json());
        expect(body.holdings.war).toEqual({ status: 'UNAVAILABLE' });
        expect(body.currentWindow.warPoints).toBe(64);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is unpublished where nothing reads the chain', async () => {
      expect((await holdingsFrom(withBalance(undefined))).war).toEqual({ status: 'UNPUBLISHED' });
    });
  });

  it('is never kept by a shared cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/profile', headers: AUTH });

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('GET /v1/rewards/claims (§17, §35.6)', () => {
  const PROOF = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`] as `0x${string}`[];
  const withClaims = (hasClaimed: (id: bigint) => Promise<boolean>) =>
    buildServer({
      ...serverDeps,
      rewardClaims: {
        chainId: 46630,
        distributor: `0x${'d1'.repeat(20)}`,
        decimals: 18,
        claimsOf: () =>
          Promise.resolve([
            { distributionId: 8n, amount: 400_000_000_000_000_000n, proof: PROOF },
            { distributionId: 7n, amount: 10n, proof: [] },
          ]),
        hasClaimed: (id) => hasClaimed(id),
      },
    });

  it('needs a signed-in wallet', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/rewards/claims' })).statusCode).toBe(401);
  });

  it('is unpublished where there is no distributor', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/rewards/claims', headers: AUTH });

    expect(rewardClaimsSchema.parse(response.json())).toEqual({ status: 'UNPUBLISHED' });
  });

  it('hands over each claim as the contract takes it, with its claimed status from chain', async () => {
    const server = withClaims((id) => Promise.resolve(id === 7n));

    const response = await server.inject({
      method: 'GET',
      url: '/v1/rewards/claims',
      headers: AUTH,
    });

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(rewardClaimsSchema.parse(response.json())).toEqual({
      status: 'READ',
      chainId: 46630,
      distributor: `0x${'d1'.repeat(20)}`,
      decimals: 18,
      claims: [
        { distributionId: '8', amount: '400000000000000000', proof: PROOF, claimed: false },
        { distributionId: '7', amount: '10', proof: [], claimed: true },
      ],
    });
  });

  it('says the claimed status is unknown when the chain does not answer, not false', async () => {
    const server = withClaims(() => Promise.reject(new Error('503')));

    const body = rewardClaimsSchema.parse(
      (await server.inject({ method: 'GET', url: '/v1/rewards/claims', headers: AUTH })).json(),
    );

    expect(body.status === 'READ' && body.claims.map((claim) => claim.claimed)).toEqual([
      null,
      null,
    ]);
  });
});

describe('GET /v1/rewards/secret (§8.5)', () => {
  const VAULT = `0x${'5e'.repeat(20)}` as const;
  const withVault = (entitlementOf: () => Promise<'NONE' | 'RESERVED' | 'CLAIMED'>) =>
    buildServer({
      ...serverDeps,
      secretClaim: {
        chainId: 46630,
        vault: VAULT,
        decimals: 6,
        amount: 200_000n,
        entitlementOf,
      },
    });

  it('needs a signed-in wallet', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/rewards/secret' })).statusCode).toBe(401);
  });

  it('is unavailable where no vault is configured', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/rewards/secret', headers: AUTH });

    expect(secretClaimSchema.parse(response.json())).toEqual({ status: 'UNAVAILABLE' });
  });

  it('says what the vault holds for the wallet, and what a claim pays', async () => {
    const server = withVault(() => Promise.resolve('RESERVED'));

    const response = await server.inject({
      method: 'GET',
      url: '/v1/rewards/secret',
      headers: AUTH,
    });

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(secretClaimSchema.parse(response.json())).toEqual({
      status: 'READ',
      chainId: 46630,
      vault: VAULT,
      decimals: 6,
      amount: '200000',
      entitlement: 'RESERVED',
    });
    await server.close();
  });

  it('is unavailable when the chain does not answer, never a wallet holding nothing', async () => {
    // §8.5 gives a reservation no expiry; telling a winner they have none
    // because an endpoint was slow is the one wrong answer here.
    const server = withVault(() => Promise.reject(new Error('503')));

    const body = secretClaimSchema.parse(
      (await server.inject({ method: 'GET', url: '/v1/rewards/secret', headers: AUTH })).json(),
    );

    expect(body.status).toBe('UNAVAILABLE');
    await server.close();
  });
});

describe('Genesis (§47.4, §69.6)', () => {
  /** A chain a test moves by hand, and a flow over it holding `balance` for WALLET. */
  function withGenesis(balance: bigint, chainDown = false) {
    const blocks = { head: 62_000_000, finalized: 61_000_000 };
    const genesis = new GenesisFlow({
      repository: new MemoryGenesisRepository(),
      chain: {
        headBlock: () =>
          chainDown ? Promise.reject(new Error('503')) : Promise.resolve(blocks.head),
        finalizedBlock: (number) =>
          Promise.resolve(
            number > blocks.finalized
              ? null
              : { number, hash: `0x${number.toString(16).padStart(64, '0')}` },
          ),
      },
      warBalanceOf: () => Promise.resolve(baseUnits(balance)),
      warDecimals: tokenDecimals(18),
      secretVault: null,
      now: () => now,
    });
    return { server: buildServer({ ...serverDeps, genesis }), blocks };
  }
  const MILLION = 1_000_000n * 10n ** 18n;
  const call = (server: FastifyInstance, method: 'GET' | 'POST', url: string) =>
    server.inject({ method, url, headers: AUTH });

  it('needs a signed-in wallet', async () => {
    const { server } = withGenesis(MILLION);

    expect((await server.inject({ method: 'GET', url: '/v1/genesis' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/genesis/request' })).statusCode).toBe(
      401,
    );
  });

  it('is unpublished, and refuses a request, where nothing reads the chain', async () => {
    const read = await call(app, 'GET', '/v1/genesis');
    expect(genesisStatusSchema.parse(read.json())).toEqual({ status: 'UNPUBLISHED' });

    const asked = await call(app, 'POST', '/v1/genesis/request');
    expect(asked.statusCode).toBe(503);
    expect(apiErrorSchema.parse(asked.json())).toMatchObject({
      code: 'GENESIS_UNAVAILABLE',
      stateIsSafe: true,
    });
  });

  it('refuses a wallet under a million $WAR, in base units with decimals', async () => {
    const { server } = withGenesis(MILLION - 1n);

    const response = await call(server, 'POST', '/v1/genesis/request');

    expect(response.statusCode).toBe(200);
    expect(genesisStatusSchema.parse(response.json())).toEqual({
      status: 'NOT_ELIGIBLE_BALANCE',
      balance: (MILLION - 1n).toString(),
      threshold: MILLION.toString(),
      decimals: 18,
    });
  });

  it('binds a request to a future block, then deals the card once it is final', async () => {
    const { server, blocks } = withGenesis(MILLION);

    const asked = genesisStatusSchema.parse(
      (await call(server, 'POST', '/v1/genesis/request')).json(),
    );
    expect(asked).toEqual({
      status: 'PENDING_FINALITY',
      requestId: genesisRequestId(WALLET),
      targetBlock: 62_000_000 + ENTROPY_TARGET_DISTANCE,
    });

    blocks.finalized = blocks.head + ENTROPY_TARGET_DISTANCE;
    const read = await call(server, 'GET', '/v1/genesis');
    const ready = genesisStatusSchema.parse(read.json());
    if (ready.status !== 'READY') throw new Error(`expected a card, got ${ready.status}`);

    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(ready.claim).toMatchObject({
      genesisId: '000001',
      wallet: WALLET,
      entropyBlock: 62_000_000 + ENTROPY_TARGET_DISTANCE,
    });
    // Asking again after the card is dealt says so (§6).
    expect(
      genesisStatusSchema.parse((await call(server, 'POST', '/v1/genesis/request')).json()),
    ).toEqual({ status: 'ALREADY_CLAIMED', claim: ready.claim });
  });

  it('answers by request id for the wallet’s own request only', async () => {
    const { server, blocks } = withGenesis(MILLION);
    const ownUrl = `/v1/genesis/${genesisRequestId(WALLET)}`;

    expect((await call(server, 'GET', ownUrl)).statusCode).toBe(404);
    await call(server, 'POST', '/v1/genesis/request');
    blocks.finalized = Number.MAX_SAFE_INTEGER;

    const byId = genesisStatusSchema.parse((await call(server, 'GET', ownUrl)).json());
    const finalized = genesisStatusSchema.parse(
      (await call(server, 'POST', `${ownUrl}/finalize`)).json(),
    );
    expect(byId.status).toBe('READY');
    expect(finalized).toEqual(byId);

    const someoneElse = await call(
      server,
      'GET',
      '/v1/genesis/genesis-0x00000000000000000000000000000000000000aa',
    );
    expect(someoneElse.statusCode).toBe(404);
    expect(apiErrorSchema.parse(someoneElse.json()).code).toBe('GENESIS_REQUEST_NOT_FOUND');
  });

  it('puts the dealt card on the profile, with the charges its card has left (§34.2)', async () => {
    const { server, blocks } = withGenesis(MILLION);
    const profile = async () =>
      profileSchema.parse((await call(server, 'GET', '/v1/profile')).json()).holdings.genesis;

    expect(await profile()).toEqual({ status: 'READ', card: null });

    await call(server, 'POST', '/v1/genesis/request');
    blocks.finalized = Number.MAX_SAFE_INTEGER;
    const ready = genesisStatusSchema.parse((await call(server, 'GET', '/v1/genesis')).json());
    if (ready.status !== 'READY') throw new Error(`expected a card, got ${ready.status}`);
    // The card table is the store's; here the holding stands in for it.
    holdings.set(WALLET, {
      cardInstanceId: 'card-000001',
      cardType: ready.claim.cardType,
      remainingUses: ready.claim.initialUses - 1,
    });

    expect(await profile()).toEqual({
      status: 'READ',
      card: {
        genesisId: '000001',
        rarity: ready.claim.rarity,
        cardType: ready.claim.cardType,
        initialUses: ready.claim.initialUses,
        remainingUses: ready.claim.initialUses - 1,
      },
    });
  });

  it('says the chain did not answer, and that nothing was decided', async () => {
    const { server } = withGenesis(MILLION, true);

    const response = await call(server, 'POST', '/v1/genesis/request');

    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json())).toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
      stateIsSafe: true,
    });
    expect(genesisStatusSchema.parse((await call(server, 'GET', '/v1/genesis')).json())).toEqual({
      status: 'NONE',
    });
  });
});

describe('a card the wallet cannot deploy', () => {
  // A card that reaches the engine earns support and a card assist whether or
  // not anyone holds it, and War Points divide the rewards pool. So arming one
  // is refused unless the wallet holds a card with a charge left.

  it('is refused when a pick arms it with no card on record, and nothing is recorded', async () => {
    holdings.delete(WALLET);

    const response = await app.inject({
      method: 'PUT',
      url: pickUrl(),
      headers: AUTH,
      payload: pickBody({ cardDecision: 'USE' }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'NO_CARD_TO_USE', stateIsSafe: true });
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(0);
  });

  it('is refused when the card has no charge left', async () => {
    holdings.set(WALLET, { cardInstanceId: 'card-1', cardType: 'BULL_RUN', remainingUses: 0 });
    await app.inject({ method: 'PUT', url: pickUrl(), headers: AUTH, payload: pickBody() });

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/card-decision`,
      headers: AUTH,
      payload: { roundId: ROUND_ID, decision: 'USE', clientRequestId: 'req-card-empty' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'NO_CARD_TO_USE' });
    expect((await picks.find(toRoundId(ROUND_ID), WALLET))?.cardDecision).toBe('SAVE');
  });

  it('never stands in the way of saving the card, or of a pick without one', async () => {
    holdings.delete(WALLET);

    const pick = await app.inject({
      method: 'PUT',
      url: pickUrl(),
      headers: AUTH,
      payload: pickBody({ cardDecision: 'SAVE' }),
    });
    const save = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/card-decision`,
      headers: AUTH,
      payload: { roundId: ROUND_ID, decision: 'SAVE', clientRequestId: 'req-card-save' },
    });

    expect(pick.statusCode).toBe(201);
    expect(save.statusCode).toBe(200);
  });
});

describe('a request body', () => {
  it('is refused past the limit before any route reads it', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: pickUrl(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...pickBody(), padding: 'x'.repeat(MAX_BODY_BYTES) }),
    });

    expect(response.statusCode).toBe(413);
    expect(await picks.count(toRoundId(ROUND_ID))).toBe(0);
  });
});
