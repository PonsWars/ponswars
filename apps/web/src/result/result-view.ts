import {
  BATTLE_POINT_SCALE,
  isUpset,
  totalScore,
  winningPickWp,
  type ActiveTicker,
  type BattleScoreBreakdown,
  type ConfidenceLabel,
  type FinalizedBattleResult,
  type VictoryLabel,
} from '@ponswars/shared-types';

/**
 * The battle result, as the player reads it (§25, §27.8).
 *
 * This is the *only* place a score becomes visible. §12.5 and §48.3 hide it for
 * the whole live battle, and it is revealed here rather than by flying closer —
 * which is why the input is a `FinalizedBattleResult` and not anything a live
 * feed could supply. There is no path from a running battle to this module.
 *
 * Nothing is recomputed. The breakdown, the winner and the victory label all
 * come from the engine that produced the result; a client that re-derived any of
 * them could disagree with the record every spectator is supposed to converge on
 * (§61 acceptance principle 3).
 */

export interface SideResultView {
  readonly ticker: ActiveTicker;
  readonly breakdown: BattleScoreBreakdown;
  /** That side's share of the 100 points, to one decimal. */
  readonly totalLabel: string;
  readonly won: boolean;
}

export interface ResultView {
  readonly left: SideResultView;
  readonly right: SideResultView;
  readonly winner: ActiveTicker;
  readonly victoryLabel: VictoryLabel;
  /** Set only when the totals tied and a tiebreak step decided it (§12.7). */
  readonly tiebreakStep: string | null;
  /** Provenance, so a result can be argued with rather than only believed. */
  readonly scoringEngineVersion: string;
  readonly evidenceHash: string;
}

export function resultView(result: FinalizedBattleResult): ResultView {
  return {
    left: sideView(result.left, result.leftScore, result.winner === result.left),
    right: sideView(result.right, result.rightScore, result.winner === result.right),
    winner: result.winner,
    victoryLabel: result.victoryLabel,
    tiebreakStep: result.tiebreakStep ?? null,
    scoringEngineVersion: result.scoringEngineVersion,
    evidenceHash: result.evidenceHash,
  };
}

function sideView(
  ticker: ActiveTicker,
  breakdown: BattleScoreBreakdown,
  won: boolean,
): SideResultView {
  return { ticker, breakdown, totalLabel: formatScore(totalScore(breakdown)), won };
}

/**
 * Formats a score component to one decimal place.
 *
 * The engine carries points scaled by `BATTLE_POINT_SCALE` — one point is
 * 1 000 000 —
 * so a component arrives as a large integer and this is where it becomes
 * readable. Rounded half up in integer arithmetic, never by dividing into a
 * float: ADR 0003 keeps value-bearing numbers out of floating point, and the
 * result screen is the one place those numbers are shown to the person they
 * were computed for.
 *
 * Getting this wrong is not subtle in hindsight and was not obvious in advance:
 * an earlier version assumed tenths and rendered a 48.4 as `4840954.0`. The
 * fixture it was tested against had been written to match the assumption rather
 * than the engine, so the test agreed with the bug.
 */
export function formatScore(scaled: number): string {
  if (!Number.isInteger(scaled)) {
    throw new RangeError(`A score is carried as a scaled integer, received ${String(scaled)}`);
  }
  const perTenth = POINT_SCALE_NUMBER / 10;
  const negative = scaled < 0;
  const magnitude = Math.abs(scaled);
  const tenths = Math.floor((magnitude + perTenth / 2) / perTenth);
  return `${negative ? '-' : ''}${String(Math.floor(tenths / 10))}.${String(tenths % 10)}`;
}

/**
 * `BATTLE_POINT_SCALE` as a `number`.
 *
 * The engine works in `bigint`; a `FinalizedBattleResult` has already narrowed
 * each component to a `number` at the boundary, so the scale is needed in the
 * same form to undo it.
 *
 * Read from `@ponswars/shared-types` and not from the scoring engine: the
 * engine imports `node:crypto`, and pulling it into a browser bundle for one
 * constant reaches server-only code from the client's import graph.
 */
const POINT_SCALE_NUMBER = Number(BATTLE_POINT_SCALE);

/**
 * What the player earned from this result (§11, §27.8).
 *
 * `winningPickWp` is the locked award table, so the number here is the same one
 * the Rewards Engine will credit. Recomputing it from a rule typed out in the
 * client is how a result screen and a War Point balance start disagreeing.
 */
export interface PlayerResultView {
  readonly backed: ActiveTicker;
  readonly won: boolean;
  readonly warPoints: number;
  /** Whether the win qualified as an upset (§11). */
  readonly upset: boolean;
  /** Whether a deployed Genesis Card contributed to the award (§11). */
  readonly cardAssist: boolean;
}

export function playerResultView(input: {
  readonly backed: ActiveTicker;
  readonly winner: ActiveTicker;
  readonly winnerConfidence: ConfidenceLabel;
  readonly cardDeployed: boolean;
}): PlayerResultView {
  const won = input.backed === input.winner;
  return {
    backed: input.backed,
    won,
    // A loss earns nothing, so there is no award to look up. Asking the table
    // for one anyway would give the winner's number to the wrong player.
    warPoints: won ? winningPickWp(input.winnerConfidence, input.cardDeployed) : 0,
    upset: won && isUpset(input.winnerConfidence),
    cardAssist: won && input.cardDeployed,
  };
}
