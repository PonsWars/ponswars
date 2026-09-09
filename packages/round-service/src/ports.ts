import type { LockedPick, RoundEngineState, RoundFinalization } from '@ponswars/battle-engine';
import type { ConfidenceLookback, SideInputs } from '@ponswars/battle-math';
import type { Channel } from '@ponswars/realtime';
import type { ActiveTicker, FeedHealth, RoundId, UtcTimestamp } from '@ponswars/shared-types';

/**
 * What the round loop needs from the outside world.
 *
 * Five interfaces, each one thing the engine cannot compute for itself: what
 * the market did, what players picked, what the chain says, where to publish,
 * and where to persist. Everything else — matchmaking, scoring, momentum,
 * victory, awards — is already deterministic and lives in the engine.
 *
 * These are ports, not choices. Which database, which market-data vendor, which
 * WebSocket server and which RPC provider are all still `OPEN` (§102), and
 * naming one here would ship that decision as policy. Naming the *shape* it
 * plugs into does not: the shape is fixed by what the engine consumes and by
 * the schema in `database/migrations`, both of which already exist.
 *
 * Every method is async because every one of them is IO. That is the boundary
 * where the purity of the rest of this repository deliberately ends — one file,
 * five interfaces, and everything behind them is someone else's problem.
 */

/** One side's market observation at an instant (§12.1, §23.6). */
export interface MarketObservation {
  readonly inputs: SideInputs;
  readonly health: FeedHealth;
}

/**
 * The market and Pons data a battle is scored from.
 *
 * Returns health alongside the numbers rather than throwing on a bad feed. §23.6
 * makes degraded data usable and stale data not, and that is a distinction the
 * engine makes — a source that threw would take the decision away from it.
 */
export interface MarketDataPort {
  observe(ticker: ActiveTicker, at: UtcTimestamp): Promise<MarketObservation>;
  /**
   * What a ticker did over the fifteen minutes before Pick Phase (§10.1).
   *
   * A separate method rather than a field on `MarketObservation`, because it is
   * a different window read at a different moment: this one once, when the
   * round opens, and `observe` once a second for the nine minutes after lock.
   * A vendor will almost certainly serve them from different endpoints for the
   * same reason, and folding them together here would make one call fetch data
   * the caller does not need six hundred times a round.
   *
   * It returns no health. §23.6 lets a degraded feed still score a battle, but
   * confidence is screening shown before anything is at stake — if the numbers
   * are late, the labels are simply drawn from what arrived.
   */
  lookback(ticker: ActiveTicker, at: UtcTimestamp): Promise<ConfidenceLookback>;
}

/**
 * Picks submitted during the phase, read once at lock.
 *
 * Read at lock and never again: §22 allows mutation only while `PICK_OPEN`, and
 * the engine is given the frozen set precisely so it cannot see a pick that
 * could still change.
 */
export interface PickPort {
  lockedPicks(roundId: RoundId): Promise<readonly LockedPick[]>;
}

/**
 * The chain, for the one thing finalization needs from it (§13.6).
 *
 * A block hash at finalization, which makes the tiebreak unpredictable in
 * advance and verifiable afterwards.
 */
export interface ChainPort {
  finalizationBlockHash(at: UtcTimestamp): Promise<string>;
}

/**
 * Where public events go (§48, §70.1).
 *
 * Sequencing belongs to the adapter, not to the caller: a sequence is per
 * channel and must survive a restart, so the thing that owns the connection
 * owns the counter. `emit` in `@ponswars/realtime` is what an adapter uses.
 */
export interface PublisherPort {
  publish(event: string, channel: Channel, at: UtcTimestamp, payload: unknown): Promise<void>;
}

/**
 * Durable round state (§21.3, `database/migrations`).
 *
 * `saveState` is called after every transition, so a restart resumes rather
 * than replays. `saveFinalization` is separate because it writes results,
 * evidence and War Points — the exactly-once boundary of §66.6, and the one
 * write in this system that must never happen twice.
 */
export interface RoundStorePort {
  saveState(state: RoundEngineState): Promise<void>;
  saveFinalization(finalization: RoundFinalization): Promise<void>;
  /**
   * The most recent round as it was last checkpointed, or `null` for a store
   * that has never held one.
   *
   * §25 requires the engine to recover from a process restart, and a port that
   * could only write could not do that — a service coming back up had no way to
   * learn that a round was halfway through its battles. The checkpoint carries
   * the whole engine state: scores, momentum memory, sequence and the running
   * evidence digest, because resuming with a fresh momentum window or a broken
   * digest is a different battle that happens to have the same score.
   *
   * A finalized round is still the most recent one. The caller decides whether
   * to resume it or open the next; §22 makes that a transition rather than
   * something the store guesses at.
   */
  loadLatest(): Promise<RoundEngineState | null>;
}

/** Everything the loop needs, in one bag. */
export interface RoundPorts {
  readonly marketData: MarketDataPort;
  readonly picks: PickPort;
  readonly chain: ChainPort;
  readonly publisher: PublisherPort;
  readonly store: RoundStorePort;
}
