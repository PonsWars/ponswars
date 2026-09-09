import type { LockedPick, RoundEngineState, RoundFinalization } from '@ponswars/battle-engine';
import { emit, EMPTY_SEQUENCER, type Channel, type Envelope } from '@ponswars/realtime';
import type { ConfidenceLookback } from '@ponswars/battle-math';
import type { ActiveTicker, RoundId, UtcTimestamp } from '@ponswars/shared-types';
import type {
  ChainPort,
  MarketDataPort,
  MarketObservation,
  PickPort,
  PublisherPort,
  RoundPorts,
  RoundStorePort,
} from './ports.js';

/**
 * In-memory implementations of every port.
 *
 * These exist so the loop can be run and asserted without a database, a socket
 * or a chain — and so anyone writing a real adapter has a working reference for
 * what each port is expected to do.
 *
 * They are deliberately **not** a default. §102 forbids shipping an `OPEN`
 * choice as policy, and "the round service defaults to storing rounds in a Map"
 * would be exactly that. Nothing here is exported as a fallback the production
 * wiring could reach by forgetting to configure something; a caller has to
 * choose these explicitly, and a test is the only sensible reason to.
 */

/** Records what was published, in order, with real per-channel sequencing. */
export class MemoryPublisher implements PublisherPort {
  private sequencer = EMPTY_SEQUENCER;
  readonly published: Envelope<unknown>[] = [];

  publish(event: string, channel: Channel, at: UtcTimestamp, payload: unknown): Promise<void> {
    // Sequenced through `emit` rather than by pushing to an array, so the
    // ordering guarantees a client depends on (§70.1) are the ones under test.
    const result = emit(this.sequencer, event, channel, at, payload);
    this.sequencer = result.state;
    this.published.push(result.envelope);
    return Promise.resolve();
  }

  /** Every envelope on one channel, in the order it was emitted. */
  on(channel: Channel): readonly Envelope<unknown>[] {
    return this.published.filter((envelope) => envelope.channel === channel);
  }

  eventsOf(event: string): readonly Envelope<unknown>[] {
    return this.published.filter((envelope) => envelope.event === event);
  }
}

/** Keeps the latest state and every finalization it was given. */
export class MemoryRoundStore implements RoundStorePort {
  latest: RoundEngineState | null = null;
  readonly finalizations: RoundFinalization[] = [];
  /** How many times state was written, so a test can see the write pattern. */
  saveCount = 0;

  saveState(state: RoundEngineState): Promise<void> {
    this.latest = state;
    this.saveCount += 1;
    return Promise.resolve();
  }

  saveFinalization(finalization: RoundFinalization): Promise<void> {
    this.finalizations.push(finalization);
    this.latest = finalization.state;
    return Promise.resolve();
  }

  loadLatest(): Promise<RoundEngineState | null> {
    // Whatever was written last, unchanged. This store is a `Map` with a nicer
    // name: it proves the port's shape and cannot prove anything about
    // durability, which is the whole reason a real adapter exists.
    return Promise.resolve(this.latest);
  }
}

/** Returns whatever picks it was seeded with. */
export class MemoryPickSource implements PickPort {
  constructor(private readonly picks: readonly LockedPick[] = []) {}

  lockedPicks(_roundId: RoundId): Promise<readonly LockedPick[]> {
    return Promise.resolve(this.picks);
  }
}

/** Returns one fixed block hash. */
export class MemoryChain implements ChainPort {
  constructor(private readonly hash: string) {}

  finalizationBlockHash(_at: UtcTimestamp): Promise<string> {
    return Promise.resolve(this.hash);
  }
}

/**
 * Serves observations from a supplied function.
 *
 * A function rather than a table, because a market is a function of ticker and
 * time and a test usually wants to vary one of them — including varying feed
 * health, which is the input the engine's degradation paths turn on.
 */
export class MemoryMarketData implements MarketDataPort {
  constructor(
    private readonly source: (ticker: ActiveTicker, at: UtcTimestamp) => MarketObservation,
    /**
     * The confidence lookback, when a test needs one.
     *
     * Required to be passed explicitly rather than defaulted to something
     * neutral: a lookback silently returning a flat market would label every
     * matchup `EVEN`, and a test about upsets would pass while proving nothing.
     * A test that never opens a round never calls this.
     */
    private readonly lookbackSource?: (
      ticker: ActiveTicker,
      at: UtcTimestamp,
    ) => ConfidenceLookback,
  ) {}

  observe(ticker: ActiveTicker, at: UtcTimestamp): Promise<MarketObservation> {
    return Promise.resolve(this.source(ticker, at));
  }

  lookback(ticker: ActiveTicker, at: UtcTimestamp): Promise<ConfidenceLookback> {
    if (this.lookbackSource === undefined) {
      throw new Error(
        'MemoryMarketData was asked for a confidence lookback but was built without one',
      );
    }
    return Promise.resolve(this.lookbackSource(ticker, at));
  }
}

/** Convenience bundle of the five in-memory ports. */
export interface MemoryPorts extends RoundPorts {
  readonly marketData: MemoryMarketData;
  readonly picks: MemoryPickSource;
  readonly chain: MemoryChain;
  readonly publisher: MemoryPublisher;
  readonly store: MemoryRoundStore;
}

export function memoryPorts(input: {
  readonly market: (ticker: ActiveTicker, at: UtcTimestamp) => MarketObservation;
  readonly lookback?: (ticker: ActiveTicker, at: UtcTimestamp) => ConfidenceLookback;
  readonly picks?: readonly LockedPick[];
  readonly blockHash: string;
}): MemoryPorts {
  return {
    marketData: new MemoryMarketData(input.market, input.lookback),
    picks: new MemoryPickSource(input.picks ?? []),
    chain: new MemoryChain(input.blockHash),
    publisher: new MemoryPublisher(),
    store: new MemoryRoundStore(),
  };
}
