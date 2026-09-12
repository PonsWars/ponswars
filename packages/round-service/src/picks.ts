import type {
  ActiveTicker,
  BattleId,
  CardDecision,
  ClientRequestId,
  RoundId,
  UtcTimestamp,
  WalletAddress,
} from '@ponswars/shared-types';
import type { PickPort } from './ports.js';

/**
 * Where picks live while a round's phase is open (§4.2, §22, §47.5).
 *
 * The API writes through this and the round loop reads the frozen set through
 * `PickPort`, which this extends — one store, so the picks the engine locks are
 * the picks players were told were recorded.
 *
 * Asynchronous, because the store that deployments run is a database. The
 * first version was a synchronous `Map` in the API process, and the deployable
 * server used it: every pick of a round lived only in memory until lock, and a
 * restart during Pick Phase lost all of them — while every player who had made
 * one had been told `recorded: true`.
 */

/** A pick as the API received it (§47.5). */
export interface SubmittedPick {
  readonly wallet: WalletAddress;
  readonly roundId: RoundId;
  readonly battleId: BattleId;
  readonly backedTicker: ActiveTicker;
  readonly cardDecision: CardDecision;
  /** Server receive time (§47.5). A client's idea of when it picked is never taken. */
  readonly receivedAt: UtcTimestamp;
  /** §66.6 idempotency key. A retry carries the same one. */
  readonly clientRequestId: ClientRequestId;
}

export interface PickRepository extends PickPort {
  /**
   * Records or replaces a wallet's pick in a round.
   *
   * A request key this wallet has already used in this round returns what that
   * request stored and writes nothing (§66.6) — including when a newer decision
   * has replaced it since, so a retry arriving late cannot overwrite the choice
   * that followed it.
   *
   * Throws `PicksLockedError` once the round's picks are frozen.
   */
  submit(
    pick: SubmittedPick,
  ): Promise<{ readonly stored: SubmittedPick; readonly replayed: boolean }>;
  /** A wallet's current pick in a round, if it has one. */
  find(roundId: RoundId, wallet: WalletAddress): Promise<SubmittedPick | null>;
  /**
   * Withdraws a wallet's pick, returning whether there was one.
   *
   * The withdrawn request's key is released: picking the same thing again is a
   * new decision, not a retry. Throws `PicksLockedError` once frozen.
   */
  withdraw(roundId: RoundId, wallet: WalletAddress): Promise<boolean>;
  /**
   * Changes only the card decision, returning the updated pick, or `null` when
   * the wallet has none to decide about. Throws `PicksLockedError` once frozen.
   */
  decideCard(
    roundId: RoundId,
    wallet: WalletAddress,
    cardDecision: CardDecision,
    at: UtcTimestamp,
  ): Promise<SubmittedPick | null>;
  /** How many wallets have picked in a round. For health and metrics. */
  count(roundId: RoundId): Promise<number>;
}

/**
 * A change to a pick after the round's picks were frozen (§22).
 *
 * The API checks the phase before it writes, from the same clock the loop
 * uses; this is the store refusing the write that slips between that check and
 * the lock. §22 allows no change after lock, and a pick that landed a
 * millisecond late would be stored against a round whose engine never saw it.
 */
export class PicksLockedError extends Error {
  constructor(readonly roundId: RoundId) {
    super(`Picks for ${roundId} are locked`);
    this.name = 'PicksLockedError';
  }
}
