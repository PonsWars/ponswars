import type { RoundFinalization } from '@ponswars/battle-engine';
import type { WalletAddress } from '@ponswars/shared-types';
import { playerRecord, type PlayerRecord, type SettledPick } from './record.js';

/**
 * Where a record is read from.
 *
 * A port with one method, because the question is one question. What differs
 * between stores is only how the settled picks and window War Points are
 * fetched; `playerRecord` turns them into a record either way.
 */
export interface PlayerRecordSource {
  recordOf(wallet: WalletAddress): Promise<PlayerRecord>;
}

/**
 * A wallet's settled picks, out of finalizations held in memory.
 *
 * What finalization produced is everything a record needs: the frozen picks on
 * the round state, the results, the battles voided, and the awards. Nothing is
 * re-derived — the winner's confidence is the one the battle was set up with,
 * and the War Points are the awards the engine made, not a recomputation of
 * what they should have been.
 */
export function settledPicksIn(
  finalizations: readonly RoundFinalization[],
  wallet: WalletAddress,
): SettledPick[] {
  const settled: SettledPick[] = [];
  for (const finalization of finalizations) {
    const { state } = finalization;
    for (const pick of state.picks) {
      if (pick.wallet !== wallet) {
        continue;
      }
      const battle = state.battles.find((candidate) => candidate.setup.battleId === pick.battleId);
      if (battle === undefined) {
        continue;
      }
      const { setup } = battle;
      const result = finalization.results.find((candidate) => candidate.battleId === pick.battleId);
      const warPoints = finalization.awards
        .filter((award) => award.wallet === wallet && award.battleId === pick.battleId)
        .reduce((sum, award) => sum + award.points, 0);

      settled.push({
        roundId: state.roundId,
        battleId: pick.battleId,
        left: setup.left,
        right: setup.right,
        backed: pick.backedTicker,
        cardDeployed: pick.cardDeployed,
        settledAt: state.clock.battleEndAt,
        warPoints,
        settlement:
          result === undefined
            ? { kind: 'VOID' }
            : {
                kind: 'DECIDED',
                winner: result.winner,
                winnerConfidence:
                  result.winner === setup.left ? setup.leftIntel.label : setup.rightIntel.label,
              },
      });
    }
  }
  return settled;
}

/**
 * Records out of finalizations kept in memory, for the local stack.
 *
 * There are no distribution snapshots in memory, so every War Point is still
 * in the current window and no window is scheduled — which is exactly true of a
 * development stack nobody has run a distribution against.
 */
export class MemoryPlayerRecords implements PlayerRecordSource {
  constructor(private readonly finalizations: () => readonly RoundFinalization[]) {}

  recordOf(wallet: WalletAddress): Promise<PlayerRecord> {
    const settled = settledPicksIn(this.finalizations(), wallet);
    return Promise.resolve(
      playerRecord({
        wallet,
        settled,
        windowWarPoints: settled.reduce((sum, pick) => sum + pick.warPoints, 0),
        window: null,
      }),
    );
  }
}
