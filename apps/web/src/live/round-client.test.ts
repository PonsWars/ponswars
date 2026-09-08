import { currentRoundSchema } from '@ponswars/schemas';
import { describe, expect, it } from 'vitest';
import { fetchCurrentRound, toSnapshot } from './round-client.js';

/**
 * Mapping the server's round onto the client's.
 *
 * The body below is a real response, copied from a running local stack rather
 * than composed to suit the test. A fixture written from the mapper's point of
 * view would agree with whatever the mapper does, which is how a formatter and
 * its test can both be wrong about the same scale.
 */

const ENDPOINTS = { api: 'https://api.test', socket: 'wss://ws.test' };

/** One side's intel, as the live stack produced it. */
const intel = (
  label: string,
  priceTrend: string,
  volumePulse: string,
  ponsActivity: string,
  momentumStability: string,
) => ({ label, priceTrend, volumePulse, ponsActivity, momentumStability });

/**
 * Five battles, because §4.3 says five and the schema enforces it.
 *
 * Every label and sub-signal below came off a running stack — including
 * `GOOGL` as a `STRONG_FAVORITE` on strong price, rising volume and high Pons
 * activity, which is the one row that shows a label and its four words
 * agreeing.
 */
const BATTLES = [
  [
    'TSLA',
    'GME',
    intel('FAVORED', 'STRONG', 'NORMAL', 'LOW', 'STABLE'),
    intel('UNDERDOG', 'MIXED', 'NORMAL', 'MEDIUM', 'MIXED'),
  ],
  [
    'NVDA',
    'AMZN',
    intel('FAVORED', 'MIXED', 'NORMAL', 'LOW', 'STABLE'),
    intel('UNDERDOG', 'MIXED', 'WEAK', 'MEDIUM', 'MIXED'),
  ],
  [
    'AMD',
    'META',
    intel('UNDERDOG', 'MIXED', 'NORMAL', 'MEDIUM', 'MIXED'),
    intel('FAVORED', 'MIXED', 'NORMAL', 'HIGH', 'MIXED'),
  ],
  [
    'AAPL',
    'SPY',
    intel('UNDERDOG', 'WEAK', 'NORMAL', 'MEDIUM', 'STABLE'),
    intel('FAVORED', 'MIXED', 'RISING', 'MEDIUM', 'MIXED'),
  ],
  [
    'GOOGL',
    'MSFT',
    intel('STRONG_FAVORITE', 'STRONG', 'RISING', 'HIGH', 'UNSTABLE'),
    intel('UNDERDOG', 'MIXED', 'NORMAL', 'LOW', 'UNSTABLE'),
  ],
] as const;

const RESPONSE = {
  roundId: 'round-0000000000',
  state: 'PICK_OPEN',
  clock: {
    serverTime: 1_788_897_827_306,
    pickOpenAt: 1_788_897_827_306,
    lockAt: 1_788_897_887_306,
    battleStartAt: 1_788_897_887_306,
    battleEndAt: 1_788_898_427_306,
  },
  battles: BATTLES.map(([left, right, leftIntel, rightIntel], slot) => ({
    battleId: `round-0000000000-b${String(slot)}`,
    roundId: 'round-0000000000',
    sectorId: `sector-0${String(slot + 1)}`,
    left,
    right,
    leftIntel,
    rightIntel,
    state: 'SCHEDULED',
  })),
};

/** A `fetch` that answers once with whatever the test names. */
function stubFetch(answer: {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
}): typeof fetch {
  // The declared return type does the work; a stub only needs the two fields
  // the client actually reads.
  return () => Promise.resolve(answer as unknown as Response);
}

describe('mapping a round', () => {
  const snapshot = toSnapshot(currentRoundSchema.parse(RESPONSE));

  it('carries the intel through whole', () => {
    // §27.5 draws four sub-signals beside the label, and §11 prices an upset
    // from the label. Dropping either half here would make the panel and the
    // award disagree about who the underdog was.
    expect(snapshot.battles[4]?.leftIntel).toEqual(BATTLES[4][2]);
    expect(snapshot.battles[4]?.leftIntel.label).toBe('STRONG_FAVORITE');
    expect(snapshot.battles[4]?.rightIntel.label).toBe('UNDERDOG');
  });

  it('numbers sectors by position in the round', () => {
    expect(snapshot.battles.map((battle) => battle.sectorIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('starts every battle neutral rather than guessing', () => {
    // A battle just learned about has no momentum history, and §13 derives
    // momentum from movement over time. The first BATTLE_STATE_UPDATE replaces
    // both of these.
    expect(snapshot.battles[0]?.momentum).toBe('CONTESTED');
    expect(snapshot.battles[0]?.frontline).toBe(0.5);
  });

  it('claims no backing it has not been told about', () => {
    // §47.5 makes the wallet's own pick a separate request. `null` is "not
    // known yet", not "this player did not pick".
    expect(snapshot.battles.every((battle) => battle.backing === null)).toBe(true);
  });

  it('reports server time so the caller can hold the offset', () => {
    // §23.5: the device clock is never authority.
    expect(snapshot.serverTime).toBe(RESPONSE.clock.serverTime);
    expect(snapshot.round.clock.lockAt).toBe(RESPONSE.clock.lockAt);
  });
});

describe('fetching a round', () => {
  it('reads a well-formed response', async () => {
    const result = await fetchCurrentRound(
      ENDPOINTS,
      undefined,
      stubFetch({
        ok: true,
        json: () => Promise.resolve(RESPONSE),
      }),
    );
    expect(result.ok && result.snapshot.round.roundId).toBe('round-0000000000');
  });

  it('names an unreachable server rather than throwing at the caller', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const result = await fetchCurrentRound(ENDPOINTS, undefined, failing);
    expect(result.ok ? null : result.failure.kind).toBe('UNREACHABLE');
  });

  it('reports a rejection with its status', async () => {
    const result = await fetchCurrentRound(
      ENDPOINTS,
      undefined,
      stubFetch({ ok: false, status: 503 }),
    );
    expect(result.ok ? null : result.failure).toEqual({ kind: 'REJECTED', status: 503 });
  });

  it('refuses a body that is not the published shape, whole', async () => {
    // Not partially applied. §4.3 fixes the count at five, so four is not a
    // smaller round — it is a round with a battle missing, and rendering it
    // would show a world where one sector quietly has no war in it.
    const result = await fetchCurrentRound(
      ENDPOINTS,
      undefined,
      stubFetch({
        ok: true,
        json: () => Promise.resolve({ ...RESPONSE, battles: RESPONSE.battles.slice(0, 4) }),
      }),
    );
    expect(result.ok ? null : result.failure.kind).toBe('MALFORMED');
  });

  it('refuses a body carrying a live score', async () => {
    // §24 and §48.3: the exact score is hidden for the whole live battle. The
    // schema is strict, so a server that started attaching one fails here
    // rather than reaching a component that would render it.
    const withScore = {
      ...RESPONSE,
      battles: RESPONSE.battles.map((battle) => ({ ...battle, leftScore: 56_300_000 })),
    };
    const result = await fetchCurrentRound(
      ENDPOINTS,
      undefined,
      stubFetch({
        ok: true,
        json: () => Promise.resolve(withScore),
      }),
    );
    expect(result.ok ? null : result.failure.kind).toBe('MALFORMED');
  });
});
