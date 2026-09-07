import { createHash } from 'node:crypto';
import {
  TIEBREAK_ORDER,
  type ActiveTicker,
  type BattleSide,
  type ConfidenceLabel,
  type TiebreakStep,
  type VictoryLabel,
} from '@ponswars/shared-types';
import type { BattleScore } from './scoring.js';

/**
 * Winner resolution, tiebreaks and victory classification.
 *
 * Masterplan §12.6 (hard cutoff and finalization), §12.7 (tiebreak order),
 * §13.6 (victory labels), §11 (upset labels).
 *
 * There is no manual admin winner selection anywhere in this file, and there is
 * no path that returns "no winner" for a scored battle. A battle that cannot be
 * scored is VOID, which is decided upstream on feed integrity (§4.4) and never
 * here.
 */

/** Which side won, and what decided it. */
export interface Resolution {
  readonly winner: ActiveTicker;
  readonly winningSide: BattleSide;
  /** Present only when the totals tied and a tiebreak ran (§12.7). */
  readonly tiebreakStep?: TiebreakStep;
  /** Scaled point margin between the winner and the loser. Never negative. */
  readonly margin: bigint;
}

/**
 * Deterministic chain-derived tiebreak (§12.7, final step).
 *
 * Hashes the finalized block hash together with the battle ID and reads one bit.
 * Both inputs are fixed and public before this runs, so the outcome is
 * verifiable and nobody — including the operator — can steer it.
 *
 * @returns `'LEFT'` or `'RIGHT'`.
 */
export function chainDerivedSide(finalizedBlockHash: string, battleId: string): BattleSide {
  const normalized = /^0x/i.test(finalizedBlockHash)
    ? finalizedBlockHash.slice(2)
    : finalizedBlockHash;
  if (normalized.length === 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new TypeError('Finalized block hash must be a non-empty hex string');
  }
  if (battleId.length === 0) {
    throw new TypeError('Battle id must not be empty');
  }

  const digest = createHash('sha256')
    .update(Buffer.from('PONSWARS_TIEBREAK_V1', 'utf8'))
    .update(Buffer.from(normalized.toLowerCase(), 'hex'))
    .update(Buffer.from(battleId, 'utf8'))
    .digest();

  const first = digest[0];
  /* c8 ignore next 3 -- unreachable: a SHA-256 digest is always 32 bytes. */
  if (first === undefined) {
    throw new Error('Empty tiebreak digest');
  }
  return (first & 1) === 0 ? 'LEFT' : 'RIGHT';
}

export interface ResolutionInput {
  readonly score: BattleScore;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  readonly battleId: string;
  /** Block hash finalized at or after the cutoff, for the last tiebreak step. */
  readonly finalizedBlockHash: string;
}

/**
 * Decides a battle.
 *
 * Compares totals first, then walks the locked tiebreak order: price momentum,
 * relative volume, Pons power, chain-derived (§12.7). Card support is
 * deliberately absent from that list — letting cards decide a dead-even battle
 * would make them decisive rather than marginal, which §12.4 rules out.
 */
export function resolveBattle(input: ResolutionInput): Resolution {
  const { score, left, right, battleId, finalizedBlockHash } = input;

  const totalDelta = score.leftTotal - score.rightTotal;
  if (totalDelta !== 0n) {
    const winningSide: BattleSide = totalDelta > 0n ? 'LEFT' : 'RIGHT';
    return {
      winner: winningSide === 'LEFT' ? left : right,
      winningSide,
      margin: totalDelta > 0n ? totalDelta : -totalDelta,
    };
  }

  for (const step of TIEBREAK_ORDER) {
    if (step === 'chainDerived') {
      const winningSide = chainDerivedSide(finalizedBlockHash, battleId);
      return {
        winner: winningSide === 'LEFT' ? left : right,
        winningSide,
        tiebreakStep: step,
        margin: 0n,
      };
    }

    const delta = score.left[step] - score.right[step];
    if (delta !== 0n) {
      const winningSide: BattleSide = delta > 0n ? 'LEFT' : 'RIGHT';
      return {
        winner: winningSide === 'LEFT' ? left : right,
        winningSide,
        tiebreakStep: step,
        margin: 0n,
      };
    }
  }

  /* c8 ignore next 2 -- unreachable: the chain-derived step always returns. */
  throw new Error(`Tiebreak order exhausted without a winner for battle ${battleId}`);
}

/**
 * Margin thresholds that separate a narrow win from a decisive one.
 *
 * `CALIBRATE`: §13.6 names the labels but not the point margins that earn them,
 * so these are an input rather than a compiled default (§102).
 */
export interface VictoryThresholds {
  /** At or below this scaled margin, a win reads as NARROW. */
  readonly narrowMargin: bigint;
  /** At or above this scaled margin, a win reads as DECISIVE. */
  readonly decisiveMargin: bigint;
}

export interface ClassificationInput {
  readonly margin: bigint;
  /** The winner's pre-battle confidence, snapshotted at round open (§10.3). */
  readonly winnerConfidence: ConfidenceLabel;
  /**
   * Whether the winner trailed materially during the battle and recovered.
   *
   * History-dependent, so it cannot be derived from the final score — the
   * Battle Engine tracks it across ticks (§13.3).
   */
  readonly wasComeback: boolean;
  readonly thresholds: VictoryThresholds;
}

/**
 * Classifies a win (§13.6, §11).
 *
 * Upset labels take precedence over margin labels: §11 makes an underdog win an
 * `UPSET VICTORY` and a heavy-underdog win a `MAJOR UPSET`, and those are the
 * facts a player cares about. A comeback outranks a plain margin label for the
 * same reason.
 */
export function classifyVictory(input: ClassificationInput): VictoryLabel {
  const { margin, winnerConfidence, wasComeback, thresholds } = input;

  if (thresholds.narrowMargin < 0n || thresholds.decisiveMargin < thresholds.narrowMargin) {
    throw new RangeError('Victory thresholds must be non-negative and ordered');
  }

  if (winnerConfidence === 'HEAVY_UNDERDOG') return 'MAJOR_UPSET';
  if (winnerConfidence === 'UNDERDOG') return 'UPSET_VICTORY';
  if (wasComeback) return 'COMEBACK_VICTORY';
  if (margin <= thresholds.narrowMargin) return 'NARROW_VICTORY';
  if (margin >= thresholds.decisiveMargin) return 'DECISIVE_VICTORY';
  return 'VICTORY';
}
