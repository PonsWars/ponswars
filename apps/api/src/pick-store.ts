import type { LockedPick } from '@ponswars/battle-engine';
import { PicksLockedError, type PickRepository, type SubmittedPick } from '@ponswars/round-service';
import type { CardDecision, RoundId, UtcTimestamp, WalletAddress } from '@ponswars/shared-types';

export type { SubmittedPick } from '@ponswars/round-service';

/**
 * Picks in memory (§4.2, §22, §47.5).
 *
 * The reference implementation of `PickRepository`, for the local stack and
 * for tests. A deployment stores picks in PostgreSQL — `PostgresPickStore` —
 * because a pick in a process's memory is gone when the process is, and the
 * player who made it was told it was recorded.
 *
 * A pick is mutable until lock and frozen at it. §22 allows changes only while
 * `PICK_OPEN`, so the store keeps one entry per wallet per round and replaces it
 * on a change rather than accumulating a history the engine would have to
 * interpret. Once `lockedPicks` has been read for a round, every write to it is
 * refused, exactly as the database refuses it.
 *
 * The recorded timestamp is the server's (§47.5). A client's idea of when it
 * picked is not accepted at all — the request schema has no field for one,
 * because accepting one hands a latency argument to anyone who missed the lock.
 */
export class PickStore implements PickRepository {
  /** roundId → wallet → pick. One pick per wallet per round (§4.2). */
  private readonly byRound = new Map<string, Map<string, SubmittedPick>>();
  /**
   * Requests already applied, by wallet, round and key, so a retry is not a
   * second write.
   *
   * Scoped to the wallet and the round. It was keyed on the request key alone,
   * which let one wallet's key answer another wallet's request.
   */
  private readonly applied = new Map<string, SubmittedPick>();
  /** Rounds whose picks have been read for the engine, and are frozen. */
  private readonly locked = new Set<string>();

  submit(
    pick: SubmittedPick,
  ): Promise<{ readonly stored: SubmittedPick; readonly replayed: boolean }> {
    if (this.locked.has(pick.roundId)) {
      return Promise.reject(new PicksLockedError(pick.roundId));
    }

    const key = requestKey(pick.wallet, pick.roundId, pick.clientRequestId);
    const seen = this.applied.get(key);
    if (seen !== undefined) {
      return Promise.resolve({ stored: seen, replayed: true });
    }

    const round = this.byRound.get(pick.roundId) ?? new Map<string, SubmittedPick>();
    round.set(pick.wallet, pick);
    this.byRound.set(pick.roundId, round);
    this.applied.set(key, pick);
    return Promise.resolve({ stored: pick, replayed: false });
  }

  find(roundId: RoundId, wallet: WalletAddress): Promise<SubmittedPick | null> {
    return Promise.resolve(this.byRound.get(roundId)?.get(wallet) ?? null);
  }

  /**
   * The frozen set the engine locks (§22).
   *
   * `cardDecision` becomes `cardDeployed`: the engine cares only whether a card
   * went in, and §40.7 makes SAVE the absence of a deployment rather than a
   * second kind of it. Ordered by wallet, as the database orders it, so the
   * same picks reach the engine in the same order whichever store holds them.
   */
  lockedPicks(roundId: RoundId): Promise<readonly LockedPick[]> {
    this.locked.add(roundId);
    const round = this.byRound.get(roundId);
    if (round === undefined) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      [...round.values()]
        .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
        .map((pick) => ({
          wallet: pick.wallet,
          battleId: pick.battleId,
          backedTicker: pick.backedTicker,
          cardDeployed: pick.cardDecision === 'USE',
        })),
    );
  }

  withdraw(roundId: RoundId, wallet: WalletAddress): Promise<boolean> {
    if (this.locked.has(roundId)) {
      return Promise.reject(new PicksLockedError(roundId));
    }
    const round = this.byRound.get(roundId);
    const existing = round?.get(wallet);
    if (round === undefined || existing === undefined) {
      return Promise.resolve(false);
    }
    round.delete(wallet);
    this.applied.delete(requestKey(wallet, roundId, existing.clientRequestId));
    return Promise.resolve(true);
  }

  decideCard(
    roundId: RoundId,
    wallet: WalletAddress,
    cardDecision: CardDecision,
    at: UtcTimestamp,
  ): Promise<SubmittedPick | null> {
    if (this.locked.has(roundId)) {
      return Promise.reject(new PicksLockedError(roundId));
    }
    const existing = this.byRound.get(roundId)?.get(wallet);
    if (existing === undefined) {
      return Promise.resolve(null);
    }
    // `receivedAt` moves because the decision is what was received now. The
    // engine reads only `cardDeployed`, but an operator reading a stored pick
    // should see when its current contents were decided.
    const updated: SubmittedPick = { ...existing, cardDecision, receivedAt: at };
    this.byRound.get(roundId)?.set(wallet, updated);
    return Promise.resolve(updated);
  }

  count(roundId: RoundId): Promise<number> {
    return Promise.resolve(this.byRound.get(roundId)?.size ?? 0);
  }
}

function requestKey(wallet: WalletAddress, roundId: RoundId, clientRequestId: string): string {
  return `${wallet}|${roundId}|${clientRequestId}`;
}
