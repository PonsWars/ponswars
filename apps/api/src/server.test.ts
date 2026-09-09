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
  battleResultSchema,
  currentRoundSchema,
  rosterSchema,
  serviceStatusSchema,
} from '@ponswars/schemas';
import {
  ACTIVE_TICKERS,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
  type FinalizedBattleResult,
  walletAddress,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { PickStore } from './pick-store.js';
import { buildServer } from './server.js';

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

/** Finalized results the server can answer for, seeded per test. */
let finalized: Map<string, FinalizedBattleResult>;

let round: RoundEngineState;
let picks: PickStore;
let now: UtcTimestamp;
let app: FastifyInstance;

beforeEach(() => {
  round = openRound();
  finalized = new Map();
  picks = new PickStore();
  now = utcTimestamp(EPOCH + 30_000);
  app = buildServer({
    currentRound: () => round,
    picks,
    config: CONFIG,
    allowedOrigins: [ALLOWED_ORIGIN],
    finalizedResult: (battleId) => finalized.get(battleId) ?? null,
    now: () => now,
    // Any bearer token is treated as that wallet. Signature verification is
    // §45.2 and belongs to the auth service; these tests are about the routes.
    walletOf: (authorization) => (authorization === undefined ? null : WALLET),
  });
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(1);
  });

  it('refuses a request with no wallet', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/rounds/${ROUND_ID}/pick`,
      payload: pickBody(),
    });
    expect(response.statusCode).toBe(401);
    expect(picks.count(toRoundId(ROUND_ID))).toBe(0);
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(0);
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(1);
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(1);
    expect(picks.find(toRoundId(ROUND_ID), WALLET)?.backedTicker).toBe(battle.setup.right);
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
    expect(locked[0]).toMatchObject({ wallet: WALLET, cardDeployed: true });
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(1);

    const response = await app.inject({ method: 'DELETE', url: pickUrl(), headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ withdrawn: true });
    expect(picks.count(toRoundId(ROUND_ID))).toBe(0);
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(1);
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
    expect(picks.count(toRoundId(ROUND_ID))).toBe(1);
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

    const stored = picks.find(toRoundId(ROUND_ID), WALLET);
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
    expect(locked[0]?.cardDeployed).toBe(false);
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
