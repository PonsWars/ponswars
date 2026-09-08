import type { Intensity, MomentumState, NormalizedFrontline } from '@ponswars/shared-types';
import { clampUnit, RATIO_SCALE } from './scale.js';
import { FULL_SCORE_SCALED } from './scoring.js';

/**
 * War Momentum derivation (§13.3, §73.7).
 *
 * §73.7 is explicit: *"Visual momentum states must derive from score position
 * and score velocity, not random selection."* This module is that derivation,
 * and it is pure — the same tick sequence always produces the same visual
 * history, so a replay shows what players actually saw.
 *
 * Nothing here feeds the score. §13 keeps the battlefield a *visualisation* of
 * authoritative state: momentum changes the frontline, the intensity and the
 * event cues, and changes the winner not at all.
 */

/**
 * Signed lead, scaled: `+RATIO_SCALE` is total left dominance, `0` is dead even.
 */
export type Advantage = bigint;

/**
 * Thresholds separating the momentum states.
 *
 * `TUNABLE` per §73.7 — *"Exact visual thresholds are TUNABLE, but may not
 * change winner math."* They are an input rather than compiled constants, and
 * `docs/OPEN_PARAMETERS.md` tracks them as calibration. Nothing downstream of
 * them touches the score.
 */
export interface MomentumThresholds {
  /** Advantage at which a lead reads as `PUSHING` rather than `CONTESTED`. */
  readonly push: Advantage;
  /** Advantage at which it reads as `SURGING`. */
  readonly surge: Advantage;
  /** Advantage at which it reads as `DOMINATING`. */
  readonly dominance: Advantage;
  /**
   * How far a side must have trailed for its later lead to read as a
   * `COMEBACK`. §13.3 lists COMEBACK as a state in its own right, and it is the
   * only one that cannot be read off the current position.
   */
  readonly comeback: Advantage;
}

/**
 * What the derivation remembers between ticks.
 *
 * Threaded through by the caller rather than held in a mutable object, so the
 * engine can checkpoint it alongside the rest of the round state (§25) and a
 * replay can resume mid-battle.
 */
export interface MomentumMemory {
  /** Largest advantage the left side has held so far. */
  readonly peakLeft: Advantage;
  /** Largest advantage the right side has held so far. */
  readonly peakRight: Advantage;
  /** Advantage at the previous tick, for velocity. */
  readonly previous: Advantage;
  readonly ticks: number;
}

export const INITIAL_MOMENTUM_MEMORY: MomentumMemory = {
  peakLeft: 0n,
  peakRight: 0n,
  previous: 0n,
  ticks: 0,
};

export interface MomentumSample {
  readonly state: MomentumState;
  readonly frontline: NormalizedFrontline;
  readonly intensity: Intensity;
  /** Signed lead this tick, retained as evidence for the visual history. */
  readonly advantage: Advantage;
  /** Change since the previous tick. Zero on the first. */
  readonly velocity: Advantage;
  readonly memory: MomentumMemory;
}

/**
 * Signed advantage from a pair of scaled totals.
 *
 * `(left - right) / total`, so a 60/40 split gives `+0.2` — which is the
 * measure §13.1 speaks in when it maps 55/45 to a slight push and 70/30 to a
 * dominant one.
 */
export function advantageFromScores(leftTotal: bigint, rightTotal: bigint): Advantage {
  const total = leftTotal + rightTotal;
  if (total <= 0n) {
    return 0n;
  }
  return clampUnit(((leftTotal - rightTotal) * RATIO_SCALE) / total);
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Advances the momentum derivation by one tick.
 *
 * Order of precedence is deliberate. A comeback outranks a position-based state
 * because it describes something that happened rather than something that is —
 * a side that trailed badly and now leads is the more interesting fact, and it
 * is the one §13.3 names separately.
 */
export function nextMomentum(
  memory: MomentumMemory,
  advantage: Advantage,
  thresholds: MomentumThresholds,
): MomentumSample {
  assertThresholds(thresholds);

  const clamped = clampUnit(advantage);
  const velocity = memory.ticks === 0 ? 0n : clamped - memory.previous;

  const peakLeft = clamped > memory.peakLeft ? clamped : memory.peakLeft;
  const peakRight = -clamped > memory.peakRight ? -clamped : memory.peakRight;

  const lead = magnitude(clamped);

  // A comeback needs the *other* side to have led by the threshold earlier. The
  // check uses the peak before this tick folded in, so a single tick cannot be
  // both the deepest deficit and the recovery from it.
  const trailedBadly =
    clamped > 0n ? memory.peakRight >= thresholds.comeback : memory.peakLeft >= thresholds.comeback;
  const isComeback = lead > 0n && trailedBadly;

  let state: MomentumState;
  if (isComeback) {
    state = 'COMEBACK';
  } else if (lead >= thresholds.dominance) {
    state = 'DOMINATING';
  } else if (lead >= thresholds.surge) {
    state = 'SURGING';
  } else if (lead >= thresholds.push) {
    state = 'PUSHING';
  } else {
    state = 'CONTESTED';
  }

  return {
    state,
    frontline: frontlineFromAdvantage(clamped),
    intensity: intensityFrom(lead, velocity),
    advantage: clamped,
    velocity,
    memory: { peakLeft, peakRight, previous: clamped, ticks: memory.ticks + 1 },
  };
}

/**
 * Frontline position as the left side's share, in `[0, 1]`.
 *
 * §13.1 speaks in shares — 50/50 contested, 70/30 dominant — so the visual
 * mapping is the advantage recentred on a half.
 */
export function frontlineFromAdvantage(advantage: Advantage): NormalizedFrontline {
  const share = Number(clampUnit(advantage)) / Number(RATIO_SCALE);
  return 0.5 + share / 2;
}

/**
 * Visual intensity in `[0, 1]`.
 *
 * Rises with both the size of the lead and how fast it is moving, so a tense
 * even battle with the frontline swinging reads as intense — which a
 * position-only measure would render as calm.
 */
function intensityFrom(lead: bigint, velocity: bigint): Intensity {
  const leadPart = Number(lead) / Number(RATIO_SCALE);
  // Velocity is a per-tick delta and therefore small; scaling it up lets a fast
  // swing register without letting it alone saturate the meter.
  const velocityPart = Math.min(1, (Number(magnitude(velocity)) / Number(RATIO_SCALE)) * 20);
  return Math.min(1, leadPart * 0.6 + velocityPart * 0.4);
}

function assertThresholds(thresholds: MomentumThresholds): void {
  const { push, surge, dominance, comeback } = thresholds;
  if (push <= 0n || surge <= push || dominance <= surge) {
    throw new RangeError('Momentum thresholds must be positive and strictly increasing');
  }
  if (comeback <= 0n || comeback > RATIO_SCALE) {
    throw new RangeError('Comeback threshold must be within the unit interval');
  }
}

/**
 * Whether the winner should be labelled a comeback (§13.6).
 *
 * Read from the final memory rather than recomputed, so the result label agrees
 * with what the battlefield actually showed.
 */
export function wasComeback(
  memory: MomentumMemory,
  finalAdvantage: Advantage,
  threshold: Advantage,
): boolean {
  if (finalAdvantage === 0n) {
    return false;
  }
  return finalAdvantage > 0n ? memory.peakRight >= threshold : memory.peakLeft >= threshold;
}

/**
 * Converts a scaled score pair straight to an advantage.
 *
 * The totals always sum to {@link FULL_SCORE_SCALED}, so this is the common
 * path and saves callers re-deriving the denominator.
 */
export function advantageFromBattleScore(leftTotal: bigint): Advantage {
  return advantageFromScores(leftTotal, FULL_SCORE_SCALED - leftTotal);
}
