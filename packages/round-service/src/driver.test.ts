import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  nextRoundOpensAt,
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
  ACTIVE_TICKERS,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { runRounds, type DriverEvent } from './driver.js';
import { memoryPorts, type MemoryPorts } from './memory.js';

/**
 * Where the driver starts, which is where a restart lands (§3.1, §25).
 *
 * The loop's behaviour inside a round is `loop.test.ts`. This is the part that
 * only happens at the edges — a first start, a restart after a finalized round,
 * a restart in the middle of one — and it is the part a durable store exposes:
 * against memory a mistake here costs one round, against PostgreSQL it rewrites
 * history.
 */

const EPOCH = utcTimestamp(1_800_000_000_000);
const BASE_SEED = `0x${'5c'.repeat(32)}`;
const ROUND_MS = 10 * 60_000;

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

const CALIBRATION: ConfidenceCalibration = {
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: (RATIO_SCALE * 13n) / 10n, weak: (RATIO_SCALE * 7n) / 10n },
  ponsActivity: { high: 40n, medium: 15n },
  momentumStability: { stable: 2, mixed: 5 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

const FLAT: ConfidenceLookback = {
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 20n,
  subWindowReturns: [10n, 10n, 10n],
};

function ports(): MemoryPorts {
  return memoryPorts({
    // Nothing here should score a battle: every test stops the driver before
    // its first step, and a market read would mean it did not.
    market: () => {
      throw new Error('the driver observed the market before its first step');
    },
    lookback: () => FLAT,
    blockHash: `0x${'e1'.repeat(32)}`,
  });
}

/** A round as a store would hold it, at an index and in a state. */
function storedRound(index: number, state: RoundEngineState['state']): RoundEngineState {
  const round = createRound({
    roundId: toRoundId(roundIdFor(index)),
    roundIndex: index,
    clock: clockForRound(EPOCH, index, EPOCH),
    baseSeedHex: BASE_SEED,
    recentRounds: [],
    confidence: {
      lookback: Object.fromEntries(ACTIVE_TICKERS.map((ticker) => [ticker, FLAT])),
      calibration: CALIBRATION,
    },
  });
  return { ...round, state };
}

interface Started {
  readonly events: readonly DriverEvent[];
  readonly served: readonly RoundEngineState[];
  /** What happened to the ports, in order. */
  readonly log: readonly string[];
}

/** Starts the driver and stops it the moment it has a round to serve. */
async function start(bundle: MemoryPorts, now: UtcTimestamp): Promise<Started> {
  const events: DriverEvent[] = [];
  const served: RoundEngineState[] = [];
  const log: string[] = [];
  const controller = new AbortController();

  const save = bundle.store.saveState.bind(bundle.store);
  bundle.store.saveState = (state) => {
    log.push(`save ${state.roundId} ${state.state}`);
    return save(state);
  };
  const publish = bundle.publisher.publish.bind(bundle.publisher);
  bundle.publisher.publish = (event, channel, at, payload) => {
    log.push(`publish ${event}`);
    return publish(event, channel, at, payload);
  };

  await runRounds({
    ports: bundle,
    config: CONFIG,
    calibration: CALIBRATION,
    now: () => now,
    tickMs: 1_000,
    baseSeedHex: BASE_SEED,
    onRound: (round) => {
      served.push(round);
      // Stopped between steps, before the first one, so the round the driver
      // chose is the only thing that happened.
      controller.abort();
    },
    onEvent: (event) => {
      events.push(event);
    },
    signal: controller.signal,
  });

  return { events, served, log };
}

describe('the first start', () => {
  it('opens round zero from now, and saves it before announcing it', async () => {
    const bundle = ports();
    const { served, log, events } = await start(bundle, EPOCH);

    expect(served[0]?.roundId).toBe(roundIdFor(0));
    expect(served[0]?.state).toBe('PICK_OPEN');
    expect(served[0]?.clock.pickOpenAt).toBe(EPOCH);
    expect(log).toEqual([`save ${roundIdFor(0)} PICK_OPEN`, 'publish ROUND_OPENED']);
    expect(events.map((event) => event.kind)).toEqual(['OPENED']);
  });
});

describe('a restart after a finalized round', () => {
  it('opens the round after it, never round zero again', async () => {
    // The bug this pins: the driver reopened at index zero, which against a
    // durable store rewrote the first round ever played and had the War Point
    // ledger refuse every award the new round made.
    const bundle = ports();
    const finished = storedRound(7, 'FINALIZED');
    bundle.store.latest = finished;

    const { served } = await start(bundle, nextRoundOpensAt(finished.clock));

    expect(served[0]?.roundId).toBe(roundIdFor(8));
  });

  it('stays contiguous with the round before when that is still ahead', async () => {
    const bundle = ports();
    const finished = storedRound(7, 'FINALIZED');
    bundle.store.latest = finished;
    const opensAt = nextRoundOpensAt(finished.clock);

    const { served } = await start(bundle, utcTimestamp(opensAt - 2_000));

    expect(served[0]?.clock.pickOpenAt).toBe(opensAt);
  });

  it('opens from now after a long outage, rather than a round whose picks already closed', async () => {
    const bundle = ports();
    const finished = storedRound(7, 'FINALIZED');
    bundle.store.latest = finished;
    const later = utcTimestamp(nextRoundOpensAt(finished.clock) + 3 * ROUND_MS + 17_000);

    const { served } = await start(bundle, later);

    expect(served[0]?.roundId).toBe(roundIdFor(8));
    expect(served[0]?.clock.pickOpenAt).toBe(later);
  });

  it('saves the new round before announcing it', async () => {
    const bundle = ports();
    bundle.store.latest = storedRound(7, 'FINALIZED');

    const { log } = await start(bundle, nextRoundOpensAt(storedRound(7, 'FINALIZED').clock));

    expect(log).toEqual([`save ${roundIdFor(8)} PICK_OPEN`, 'publish ROUND_OPENED']);
  });
});

describe('a restart in the middle of a round', () => {
  it('resumes it, without saving or announcing it again', async () => {
    const bundle = ports();
    const live = storedRound(3, 'PICK_OPEN');
    bundle.store.latest = live;

    const { served, log, events } = await start(
      bundle,
      utcTimestamp(live.clock.pickOpenAt + 30_000),
    );

    expect(served[0]).toBe(live);
    expect(log).toEqual([]);
    expect(events.map((event) => event.kind)).toEqual(['RESUMED']);
  });
});

describe('a stored round this driver did not produce', () => {
  it('refuses to guess where the sequence continues', async () => {
    const bundle = ports();
    bundle.store.latest = { ...storedRound(2, 'FINALIZED'), roundId: toRoundId('legacy-round') };

    await expect(start(bundle, EPOCH)).rejects.toThrow(/refusing to guess/);
  });
});
