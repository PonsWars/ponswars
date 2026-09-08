import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import {
  NO_CARD_SUPPORT,
  RATIO_SCALE,
  clockForRound,
  roundIdFor,
  type ConfidenceCalibration,
  type ConfidenceLookback,
} from '@ponswars/battle-math';
import {
  ACTIVE_TICKERS,
  milliseconds,
  utcTimestamp,
  type ActiveTicker,
  type FeedHealth,
  type RoundId,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { parseEventFrame } from '@ponswars/schemas';
import { describe, expect, it } from 'vitest';
import { stepRound } from './loop.js';
import { memoryPorts, type MemoryPorts } from './memory.js';
import type { MarketObservation } from './ports.js';

/**
 * The round loop, driven end to end against in-memory ports.
 *
 * What this is really testing is composition: that the driver's decisions, the
 * engine's transitions and the ports line up into a round that runs from open
 * to finalized without anything in between inventing a value.
 */

const EPOCH = utcTimestamp(1_800_000_000_000);
const CLOCK = clockForRound(EPOCH, 0, EPOCH);
const ROUND_ID = roundIdFor(0) as RoundId;
const BLOCK = `0x${'e1'.repeat(32)}`;

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

/** A healthy observation that differs per ticker, so battles are decidable. */
function healthy(ticker: ActiveTicker, health: FeedHealth = 'HEALTHY'): MarketObservation {
  const bias = BigInt(ACTIVE_TICKERS.indexOf(ticker) + 1);
  return {
    inputs: {
      windowReturn: bias * 1_000n,
      volatility: 10_000n,
      relativeVolume: 1_000_000n + bias * 10_000n,
      qualifiedPonsActivity: bias * 10n,
      uniqueActiveWallets: bias * 5n,
      cardSupport: NO_CARD_SUPPORT,
    },
    health,
  };
}

function openRound(): RoundEngineState {
  const round = createRound({
    roundId: ROUND_ID,
    roundIndex: 0,
    clock: CLOCK,
    baseSeedHex: `0x${'5c'.repeat(32)}`,
    recentRounds: [],
    confidence: CONFIDENCE,
  });
  // `createRound` produces a prepared round; the phase opening is an explicit
  // transition the orchestrator owns, which the driver refuses to infer.
  return { ...round, state: 'PICK_OPEN' };
}

function ports(overrides: Partial<Parameters<typeof memoryPorts>[0]> = {}): MemoryPorts {
  return memoryPorts({
    market: (ticker) => healthy(ticker),
    blockHash: BLOCK,
    ...overrides,
  });
}

const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

const at = (offset: number): UtcTimestamp => utcTimestamp(EPOCH + offset);

describe('during the pick phase', () => {
  it('does nothing and touches no port', async () => {
    // Submissions arrive through the API, not the loop. The loop's job at this
    // point is to not interfere.
    const p = ports();
    const result = await stepRound(openRound(), at(30_000), p, CONFIG);

    expect(result.action.kind).toBe('ACCEPT_PICKS');
    expect(p.store.saveCount).toBe(0);
    expect(p.publisher.published).toHaveLength(0);
  });
});

describe('locking', () => {
  it('freezes the picks it was given and opens the battles', async () => {
    const round = openRound();
    const first = round.battles[0];
    if (first === undefined) {
      throw new Error('round has no battles');
    }

    // Built from the round rather than patched into a placeholder, so the
    // branded `BattleId` comes from the schedule that actually produced it.
    const p = ports({
      picks: [
        {
          wallet: wallet(1),
          battleId: first.setup.battleId,
          backedTicker: first.setup.left,
          cardDeployed: false,
        },
      ],
    });
    const result = await stepRound(round, CLOCK.lockAt, p, CONFIG);

    expect(result.action.kind).toBe('LOCK');
    expect(result.state.state).toBe('BATTLE_LIVE');
    expect(result.state.picks).toHaveLength(1);
    expect(p.store.latest?.state).toBe('BATTLE_LIVE');
  });

  it('records the lock at the round’s lock instant, not when the loop ran', async () => {
    // A service three seconds late must not record a lock three seconds late,
    // or a pick that missed the window would appear to have made it.
    const p = ports();
    const late = utcTimestamp(CLOCK.lockAt + 3_000);
    await stepRound(openRound(), late, p, CONFIG);

    const locked = p.publisher.eventsOf('PICKS_LOCKED');
    expect(locked).toHaveLength(1);
    expect(locked[0]?.emittedAt).toBe(CLOCK.lockAt);
  });

  it('announces the matchups', async () => {
    const p = ports();
    await stepRound(openRound(), CLOCK.lockAt, p, CONFIG);
    expect(p.publisher.eventsOf('PICKS_LOCKED')).toHaveLength(1);
  });
});

describe('ticking', () => {
  async function liveRound(p: MemoryPorts): Promise<RoundEngineState> {
    const locked = await stepRound(openRound(), CLOCK.lockAt, p, CONFIG);
    return locked.state;
  }

  it('scores every battle from one instant', async () => {
    const p = ports();
    const live = await liveRound(p);
    const result = await stepRound(live, at(2 * 60_000), p, CONFIG);

    expect(result.action.kind).toBe('TICK');
    const updates = p.publisher.eventsOf('BATTLE_STATE_UPDATE');
    expect(updates).toHaveLength(live.battles.length);
    for (const update of updates) {
      expect(update.emittedAt).toBe(at(2 * 60_000));
    }
  });

  it('never publishes a score', async () => {
    // §24: the exact score is not sent during a live battle just because a
    // client needs animation state. The payload is the engine's own public
    // update, which has no score field — this asserts the wire, not the type.
    const p = ports();
    const live = await liveRound(p);
    await stepRound(live, at(2 * 60_000), p, CONFIG);

    for (const envelope of p.publisher.eventsOf('BATTLE_STATE_UPDATE')) {
      const keys = Object.keys(envelope.payload as Record<string, unknown>);
      expect(keys).not.toContain('leftScoreScaled');
      expect(keys).not.toContain('rightScoreScaled');
      expect(JSON.stringify(envelope.payload)).not.toContain('Score');
    }
  });

  it('sequences each battle channel independently, starting at zero', async () => {
    const p = ports();
    const live = await liveRound(p);
    await stepRound(live, at(2 * 60_000), p, CONFIG);
    await stepRound(p.store.latest!, at(3 * 60_000), p, CONFIG);

    for (const battle of live.battles) {
      const seen = p.publisher.on(`battle:${battle.setup.battleId}`);
      expect(seen.map((envelope) => envelope.sequence)).toEqual([0, 1]);
    }
  });

  it('says nothing when a tick is ignored', async () => {
    // An unusable feed produces no update, and publishing one anyway would
    // burn a sequence number and tell subscribers something happened.
    const p = ports({ market: (ticker) => healthy(ticker, 'UNAVAILABLE') });
    const live = await liveRound(p);
    await stepRound(live, at(2 * 60_000), p, CONFIG);

    expect(p.publisher.eventsOf('BATTLE_STATE_UPDATE')).toHaveLength(0);
  });

  it('persists before it publishes', async () => {
    // A subscriber told about a frontline the server would lose on restart has
    // been told something about to stop being true.
    const p = ports();
    const live = await liveRound(p);
    const before = p.store.saveCount;
    await stepRound(live, at(2 * 60_000), p, CONFIG);
    expect(p.store.saveCount).toBeGreaterThan(before);
  });
});

describe('finalizing', () => {
  it('produces a result at the cutoff and publishes it once', async () => {
    const p = ports();
    let state = (await stepRound(openRound(), CLOCK.lockAt, p, CONFIG)).state;
    for (let minute = 1; minute <= 9; minute += 1) {
      state = (await stepRound(state, at(60_000 + minute * 60_000 - 1_000), p, CONFIG)).state;
    }

    const result = await stepRound(state, CLOCK.battleEndAt, p, CONFIG);

    expect(result.action.kind).toBe('FINALIZE');
    expect(result.finalization).toBeDefined();
    expect(result.state.state).toBe('FINALIZED');
    expect(p.publisher.eventsOf('ROUND_FINALIZED')).toHaveLength(1);
    expect(p.store.finalizations).toHaveLength(1);
  });

  it('refuses to finalize twice', async () => {
    // §25 and §66.6. A retried job must not produce a second set of results.
    const p = ports();
    let state = (await stepRound(openRound(), CLOCK.lockAt, p, CONFIG)).state;
    state = (await stepRound(state, at(5 * 60_000), p, CONFIG)).state;
    const finalized = await stepRound(state, CLOCK.battleEndAt, p, CONFIG);

    const again = await stepRound(finalized.state, CLOCK.battleEndAt, p, CONFIG);
    expect(again.action.kind).toBe('DONE');
    expect(p.store.finalizations).toHaveLength(1);
  });

  it('voids rather than inventing a result when nothing was scorable', async () => {
    // §61 principle 19. The loop reached the cutoff with no usable data and the
    // engine refused to produce a winner.
    const p = ports({ market: (ticker) => healthy(ticker, 'UNAVAILABLE') });
    const state = (await stepRound(openRound(), CLOCK.lockAt, p, CONFIG)).state;
    const result = await stepRound(state, CLOCK.battleEndAt, p, CONFIG);

    expect(result.finalization?.results).toHaveLength(0);
    expect(result.finalization?.voided.length).toBeGreaterThan(0);
    expect(result.finalization?.awards).toHaveLength(0);
  });
});

describe('an overdue finalization', () => {
  it('is reported without voiding anything', async () => {
    const p = ports();
    const stuck: RoundEngineState = { ...openRound(), state: 'FINALIZING' };
    const late = utcTimestamp(CLOCK.battleEndAt + CONFIG.finalization.maxWait + 1);

    const result = await stepRound(stuck, late, p, CONFIG);

    expect(result.action.kind).toBe('FINALIZATION_OVERDUE');
    expect(result.state).toBe(stuck);
    expect(p.store.finalizations).toHaveLength(0);
    expect(p.publisher.published).toHaveLength(0);
  });
});

describe('a full round through the loop', () => {
  it('runs open to finalized and awards War Points once each', async () => {
    const round = openRound();
    const first = round.battles[0];
    if (first === undefined) throw new Error('round has no battles');

    const picks = Array.from({ length: 20 }, (_, index) => ({
      wallet: wallet(index + 1),
      battleId: first.setup.battleId,
      backedTicker: index % 2 === 0 ? first.setup.left : first.setup.right,
      cardDeployed: index % 5 === 0,
    }));

    const p = ports({ picks });
    let state = round;
    let finalization;

    // Drive it the way a service would: ask the driver, perform, advance.
    for (const offset of [
      30_000,
      60_000,
      ...Array.from({ length: 9 }, (_, minute) => 120_000 + minute * 60_000 - 1_000),
      600_000,
    ]) {
      const result = await stepRound(state, at(offset), p, CONFIG);
      state = result.state;
      if (result.finalization !== undefined) {
        finalization = result.finalization;
      }
    }

    expect(state.state).toBe('FINALIZED');
    expect(finalization).toBeDefined();

    const seen = new Set<string>();
    for (const award of finalization?.awards ?? []) {
      const key = `${award.wallet}|${award.battleId}|${award.reason}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('the published contract', () => {
  it('emits only frames that parse against the schemas §48 publishes', async () => {
    // The test this file most needed. The schemas described a flat message with
    // a `type` field and no channel, and the gateway sends a sequenced envelope
    // wrapping a payload — so nothing validated what actually travels, at
    // either end, and the two shapes drifted without a single test noticing.
    //
    // Driving a whole round and parsing every frame is what makes that
    // impossible to repeat: a payload that gains a field, or an event published
    // under a name §48.3 does not list, fails here.
    const round = openRound();
    const first = round.battles[0];
    if (first === undefined) throw new Error('round has no battles');

    const p = ports({
      picks: [
        {
          wallet: wallet(1),
          battleId: first.setup.battleId,
          backedTicker: first.setup.left,
          cardDeployed: false,
        },
      ],
    });

    let state = round;
    for (const offset of [
      30_000,
      60_000,
      ...Array.from({ length: 9 }, (_, minute) => 120_000 + minute * 60_000 - 1_000),
      600_000,
    ]) {
      state = (await stepRound(state, at(offset), p, CONFIG)).state;
    }

    // Guards the loop: zero frames would make every assertion below vacuous.
    expect(p.publisher.published.length).toBeGreaterThan(5);

    for (const envelope of p.publisher.published) {
      const parsed = parseEventFrame(JSON.parse(JSON.stringify(envelope)));
      expect(parsed.ok ? null : `${envelope.event}: ${parsed.reason}`).toBeNull();
    }
  });

  it('publishes exactly the three names a round loop owns', async () => {
    // Names, not shapes. `PICKS_LOCKED` was published as `ROUND_LOCKED` — a
    // name no contract mentions — which a shape test would never have caught
    // because the payload was fine.
    //
    // The other two names in §48.3 are deliberately absent, and this asserts
    // that rather than leaving it to be noticed. `ROUND_OPENED` belongs to
    // whoever creates a round; the loop is handed one. `BATTLE_VOID` carries
    // §110.6's card-refund confirmation, which is the Player service's fact —
    // publishing it from here would mean claiming a refund happened that this
    // service never made.
    const round = openRound();
    const p = ports({});

    let state = round;
    for (const offset of [
      60_000,
      ...Array.from({ length: 9 }, (_, minute) => 120_000 + minute * 60_000 - 1_000),
      600_000,
    ]) {
      state = (await stepRound(state, at(offset), p, CONFIG)).state;
    }

    const names = new Set(p.publisher.published.map((envelope) => envelope.event));
    expect(names).toEqual(new Set(['PICKS_LOCKED', 'BATTLE_STATE_UPDATE', 'ROUND_FINALIZED']));
  });
});
