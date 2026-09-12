import {
  isUpset,
  qualifiesForDistribution,
  rewardWeight,
  type ActiveTicker,
  type BattleId,
  type ConfidenceLabel,
  type RoundId,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';

/**
 * A player's record (§34, §35, §49.2).
 *
 * Derived, never kept. §49.2 makes every cached aggregate rebuildable from the
 * authoritative ledgers, and the surest way to keep that true is to have no
 * aggregate to rebuild: a record is computed from the wallet's locked picks,
 * the results of the battles they were in, and the War Point ledger — the
 * three things finalization writes exactly once (§25).
 *
 * One function computes it, whichever store the inputs came from. The local
 * stack reads them out of memory and a deployment out of PostgreSQL, and two
 * implementations of "what counts as a win" would be two answers to a question
 * a player can check.
 */

/** How one of a wallet's picks settled. */
export type Settlement =
  | {
      readonly kind: 'DECIDED';
      readonly winner: ActiveTicker;
      /** The winner's confidence as snapshotted at open (§10.3). §11 prices upsets from it. */
      readonly winnerConfidence: ConfidenceLabel;
    }
  /** §4.4: no result, no award, and no loss. */
  | { readonly kind: 'VOID' };

/** One locked pick in a battle that has settled. */
export interface SettledPick {
  readonly roundId: RoundId;
  readonly battleId: BattleId;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  readonly backed: ActiveTicker;
  readonly cardDeployed: boolean;
  /** When the battle ended, which is when its outcome became true (§3.2). */
  readonly settledAt: UtcTimestamp;
  readonly settlement: Settlement;
  /** War Points the ledger credited this wallet for this battle (§11). */
  readonly warPoints: number;
}

/**
 * The distribution window a wallet's newest War Points count toward (§16.2).
 *
 * §16.2 starts a new window's War Points after each snapshot, so the window's
 * War Points are the ledger rows no snapshot has claimed yet. Whether a window
 * is *scheduled* — its identifier and when it closes — is the rewards
 * operator's decision, and `null` until one has been opened.
 */
export interface OpenWindow {
  readonly distributionId: string;
  readonly closesAt: UtcTimestamp;
}

export type HistoryOutcome = 'WIN' | 'UPSET_VICTORY' | 'MAJOR_UPSET' | 'LOSS' | 'VOID';

export interface HistoryEntry {
  readonly roundId: RoundId;
  readonly battleId: BattleId;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  readonly backed: ActiveTicker;
  readonly outcome: HistoryOutcome;
  readonly warPoints: number;
  readonly cardDeployed: boolean;
  readonly settledAt: UtcTimestamp;
}

export interface PlayerRecord {
  readonly wallet: WalletAddress;
  readonly lifetime: {
    /** Decided battles. A VOID battle is not one (§4.4). */
    readonly battles: number;
    readonly wins: number;
    readonly losses: number;
    /** `null` before any battle has been decided, rather than a rate of zero. */
    readonly winRateBps: number | null;
    readonly upsets: number;
    readonly majorUpsets: number;
    readonly cardAssistedWins: number;
    readonly warPoints: number;
  };
  readonly currentWindow: {
    readonly warPoints: number;
    /** §16.4: at least 50 window War Points. */
    readonly qualified: boolean;
    /** §16.5: `sqrt(WP)` at `REWARD_WEIGHT_SCALE`, as a decimal string — it is a `bigint`. */
    readonly weight: string;
    readonly window: OpenWindow | null;
  };
  /** Newest first, at most `HISTORY_LENGTH` entries. */
  readonly history: readonly HistoryEntry[];
  readonly mostBacked: {
    readonly ticker: ActiveTicker;
    readonly battles: number;
    readonly winRateBps: number;
  } | null;
  readonly biggestUpset: {
    readonly roundId: RoundId;
    readonly winner: ActiveTicker;
    readonly loser: ActiveTicker;
    readonly outcome: 'UPSET_VICTORY' | 'MAJOR_UPSET';
  } | null;
}

/** How many settled battles a record lists. The lifetime figures count all of them. */
export const HISTORY_LENGTH = 20;

export function playerRecord(input: {
  readonly wallet: WalletAddress;
  readonly settled: readonly SettledPick[];
  /** War Points in the ledger that no snapshot has claimed (§16.2). */
  readonly windowWarPoints: number;
  readonly window: OpenWindow | null;
}): PlayerRecord {
  // Newest first, with the battle id as a tiebreak: five battles in a round end
  // at the same instant, and an order that depended on how a store happened to
  // return them would reshuffle a player's history between two page loads.
  const settled = [...input.settled].sort(
    (a, b) => b.settledAt - a.settledAt || compare(a.battleId, b.battleId),
  );

  let wins = 0;
  let losses = 0;
  let upsets = 0;
  let majorUpsets = 0;
  let cardAssistedWins = 0;
  let warPoints = 0;
  const byTicker = new Map<ActiveTicker, { battles: number; wins: number }>();
  let biggestUpset: PlayerRecord['biggestUpset'] = null;

  for (const pick of settled) {
    warPoints += pick.warPoints;
    if (pick.settlement.kind === 'VOID') {
      continue;
    }

    const won = pick.backed === pick.settlement.winner;
    const tally = byTicker.get(pick.backed) ?? { battles: 0, wins: 0 };
    tally.battles += 1;

    if (!won) {
      losses += 1;
    } else {
      wins += 1;
      tally.wins += 1;
      if (pick.cardDeployed) {
        cardAssistedWins += 1;
      }
      if (isUpset(pick.settlement.winnerConfidence)) {
        upsets += 1;
        const major = pick.settlement.winnerConfidence === 'HEAVY_UNDERDOG';
        if (major) {
          majorUpsets += 1;
        }
        // The most severe, and the newest of those: iterating newest first, a
        // later upset replaces the current one only by being strictly bigger.
        if (biggestUpset === null || (major && biggestUpset.outcome !== 'MAJOR_UPSET')) {
          biggestUpset = {
            roundId: pick.roundId,
            winner: pick.settlement.winner,
            loser: pick.settlement.winner === pick.left ? pick.right : pick.left,
            outcome: major ? 'MAJOR_UPSET' : 'UPSET_VICTORY',
          };
        }
      }
    }
    byTicker.set(pick.backed, tally);
  }

  const battles = wins + losses;
  const windowWarPoints = input.windowWarPoints;

  return {
    wallet: input.wallet,
    lifetime: {
      battles,
      wins,
      losses,
      winRateBps: battles === 0 ? null : rateBps(wins, battles),
      upsets,
      majorUpsets,
      cardAssistedWins,
      warPoints,
    },
    currentWindow: {
      warPoints: windowWarPoints,
      qualified: qualifiesForDistribution(windowWarPoints),
      weight: rewardWeight(windowWarPoints).toString(),
      window: input.window,
    },
    history: settled.slice(0, HISTORY_LENGTH).map((pick) => ({
      roundId: pick.roundId,
      battleId: pick.battleId,
      left: pick.left,
      right: pick.right,
      backed: pick.backed,
      outcome: outcomeOf(pick),
      warPoints: pick.warPoints,
      cardDeployed: pick.cardDeployed,
      settledAt: pick.settledAt,
    })),
    mostBacked: mostBacked(byTicker),
    biggestUpset,
  };
}

function outcomeOf(pick: SettledPick): HistoryOutcome {
  if (pick.settlement.kind === 'VOID') {
    return 'VOID';
  }
  if (pick.backed !== pick.settlement.winner) {
    return 'LOSS';
  }
  switch (pick.settlement.winnerConfidence) {
    case 'HEAVY_UNDERDOG':
      return 'MAJOR_UPSET';
    case 'UNDERDOG':
      return 'UPSET_VICTORY';
    default:
      return 'WIN';
  }
}

/**
 * The ticker a wallet has backed most, among decided battles.
 *
 * Ties go to the better record and then to the ticker's name, so the answer is
 * one answer rather than whichever the map met first.
 */
function mostBacked(
  byTicker: ReadonlyMap<ActiveTicker, { readonly battles: number; readonly wins: number }>,
): PlayerRecord['mostBacked'] {
  let best: PlayerRecord['mostBacked'] = null;
  for (const [ticker, tally] of byTicker) {
    const winRateBps = rateBps(tally.wins, tally.battles);
    if (
      best === null ||
      tally.battles > best.battles ||
      (tally.battles === best.battles &&
        (winRateBps > best.winRateBps ||
          (winRateBps === best.winRateBps && compare(ticker, best.ticker) < 0)))
    ) {
      best = { ticker, battles: tally.battles, winRateBps };
    }
  }
  return best;
}

/** A rate in basis points, floored, so the client never divides (§66.3). */
function rateBps(part: number, whole: number): number {
  return Math.floor((part * 10_000) / whole);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
