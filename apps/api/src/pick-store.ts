import type { LockedPick } from '@ponswars/battle-engine';
import type { PickPort } from '@ponswars/round-service';
import type {
  ActiveTicker,
  BattleId,
  CardDecision,
  ClientRequestId,
  RoundId,
  UtcTimestamp,
  WalletAddress,
} from '@ponswars/shared-types';

/**
 * Picks submitted during the phase (§4.2, §22, §47.5).
 *
 * A pick is mutable until lock and frozen at it. §22 allows changes only while
 * `PICK_OPEN`, so the store keeps one entry per wallet per round and replaces it
 * on a change rather than accumulating a history the engine would have to
 * interpret.
 *
 * The recorded timestamp is the server's (§47.5). A client's idea of when it
 * picked is not accepted at all — the request schema has no field for one,
 * because accepting one hands a latency argument to anyone who missed the lock.
 *
 * This implements `PickPort`, so the round loop reads the frozen set through the
 * same interface a database adapter will satisfy.
 */

export interface SubmittedPick {
  readonly wallet: WalletAddress;
  readonly roundId: RoundId;
  readonly battleId: BattleId;
  readonly backedTicker: ActiveTicker;
  readonly cardDecision: CardDecision;
  /** Server receive time (§47.5). */
  readonly receivedAt: UtcTimestamp;
  /** §66.6 idempotency key. A retry carries the same one. */
  readonly clientRequestId: ClientRequestId;
}

export class PickStore implements PickPort {
  /** roundId → wallet → pick. One pick per wallet per round (§4.2). */
  private readonly byRound = new Map<string, Map<string, SubmittedPick>>();
  /** Idempotency keys already applied, so a retry is not a second write. */
  private readonly applied = new Map<string, SubmittedPick>();

  /**
   * Records or replaces a wallet's pick.
   *
   * A repeated `clientRequestId` returns what was stored the first time rather
   * than writing again (§66.6). That is what makes a client safe to retry a
   * request whose response it never saw — the common case on a flaky
   * connection, and the one where a naive API creates a second pick.
   */
  submit(pick: SubmittedPick): { readonly stored: SubmittedPick; readonly replayed: boolean } {
    const seen = this.applied.get(pick.clientRequestId);
    if (seen !== undefined) {
      return { stored: seen, replayed: true };
    }

    const round = this.byRound.get(pick.roundId) ?? new Map<string, SubmittedPick>();
    round.set(pick.wallet, pick);
    this.byRound.set(pick.roundId, round);
    this.applied.set(pick.clientRequestId, pick);
    return { stored: pick, replayed: false };
  }

  /** A wallet's current pick in a round, if it has one. */
  find(roundId: RoundId, wallet: WalletAddress): SubmittedPick | null {
    return this.byRound.get(roundId)?.get(wallet) ?? null;
  }

  /**
   * The frozen set the engine locks (§22).
   *
   * `cardDecision` becomes `cardDeployed`: the engine cares only whether a card
   * went in, and §40.7 makes SAVE the absence of a deployment rather than a
   * second kind of it.
   */
  lockedPicks(roundId: RoundId): Promise<readonly LockedPick[]> {
    const round = this.byRound.get(roundId);
    if (round === undefined) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      [...round.values()].map((pick) => ({
        wallet: pick.wallet,
        battleId: pick.battleId,
        backedTicker: pick.backedTicker,
        cardDeployed: pick.cardDecision === 'USE',
      })),
    );
  }

  /** How many wallets have picked in a round. For health and metrics. */
  count(roundId: RoundId): number {
    return this.byRound.get(roundId)?.size ?? 0;
  }
}
