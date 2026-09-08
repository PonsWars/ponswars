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
import { apiErrorSchema, currentRoundSchema } from '@ponswars/schemas';
import {
  ACTIVE_TICKERS,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
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

let round: RoundEngineState;
let picks: PickStore;
let now: UtcTimestamp;
let app: FastifyInstance;

beforeEach(() => {
  round = openRound();
  picks = new PickStore();
  now = utcTimestamp(EPOCH + 30_000);
  app = buildServer({
    currentRound: () => round,
    picks,
    config: CONFIG,
    now: () => now,
    // Any bearer token is treated as that wallet. Signature verification is
    // §45.2 and belongs to the auth service; these tests are about the routes.
    walletOf: (authorization) => (authorization === undefined ? null : WALLET),
  });
});

const AUTH = { authorization: 'Bearer test' };

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
