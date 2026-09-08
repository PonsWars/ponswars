import {
  advantageFromBattleScore,
  classifyVictory,
  decideFinalization,
  INITIAL_MOMENTUM_MEMORY,
  nextMomentum,
  resolveBattle,
  scoreBattle,
  wasComeback,
  type FinalizationPolicy,
  type MomentumMemory,
  type MomentumThresholds,
  type ScoringCalibration,
  type SideInputs,
  type VictoryThresholds,
} from '@ponswars/battle-math';
import {
  canTransitionBattle,
  isScorable,
  requiresVoid,
  type ActiveTicker,
  type BattleId,
  type BattleState,
  type CanonicalClock,
  type CardSupportTier,
  type ConfidenceSnapshot,
  type FeedHealth,
  type FinalizedBattleResult,
  type PublicBattleStateUpdate,
  type RoundId,
  type UtcTimestamp,
  type VoidReasonCategory,
} from '@ponswars/shared-types';
import { EMPTY_EVIDENCE, foldEvidence } from './evidence.js';
import { CURRENT_ENGINE_VERSIONS, versionTag, type EngineVersions } from './versions.js';

/**
 * The deterministic battle engine core (§73).
 *
 * Kickoff Brief §8: *"Build a deterministic simulation harness before
 * production realtime integration. The same evidence bundle must reproduce the
 * same result."*
 *
 * This module is that harness and that engine — there is not a fast production
 * path and a separate simulation path, because two implementations of the same
 * rule is exactly how a replay comes to disagree with what players saw.
 *
 * It is a reducer. No clock, no network, no database: state in, state out.
 * Everything time-dependent arrives as an explicit timestamp, and everything
 * calibrated arrives as configuration. A caller drives it from live feeds in
 * production and from recorded evidence in a replay, and both get the same
 * answer.
 */

/** Everything calibrated, in one place, so a replay can reproduce the settings. */
export interface EngineConfig {
  readonly scoring: ScoringCalibration;
  readonly momentum: MomentumThresholds;
  readonly victory: VictoryThresholds;
  readonly finalization: FinalizationPolicy;
  readonly versions: EngineVersions;
  /**
   * Card support tier boundaries for the public stream (§15).
   *
   * The client is told LOW / MEDIUM / HIGH / MAX, never a raw count —
   * *"thousands of deployed cards must not equal thousands of literal extra
   * units."*
   */
  readonly cardSupportTiers: {
    readonly medium: bigint;
    readonly high: bigint;
    readonly max: bigint;
  };
}

export interface BattleSetup {
  readonly battleId: BattleId;
  readonly roundId: RoundId;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  readonly clock: CanonicalClock;
  /**
   * Pre-battle intel for each side, snapshotted at round open (§10.1, §10.3).
   *
   * The whole snapshot rather than its label: §11 needs the label to price an
   * upset, and §27.5 needs the four sub-signals to draw the panel. Carrying
   * both together is what stops the panel and the award disagreeing about who
   * the underdog was.
   */
  readonly leftIntel: ConfidenceSnapshot;
  readonly rightIntel: ConfidenceSnapshot;
}

/**
 * The full engine state for one battle.
 *
 * Everything §25 requires in a checkpoint: state, score, momentum memory,
 * sequence and the running evidence digest. Serialising this and restoring it
 * resumes the battle exactly where it stopped.
 */
export interface BattleEngineState {
  readonly setup: BattleSetup;
  readonly state: BattleState;
  readonly tickSequence: number;
  readonly momentum: MomentumMemory;
  readonly evidenceHash: string;
  /** Latest authoritative score. Never published while the battle is live. */
  readonly leftScoreScaled: bigint;
  readonly rightScoreScaled: bigint;
  readonly lastLeft: SideInputs | null;
  readonly lastRight: SideInputs | null;
  readonly lastTickAt: UtcTimestamp | null;
  readonly voidReason: VoidReasonCategory | null;
}

/** One observation of both sides at an instant. */
export interface TickInput {
  readonly at: UtcTimestamp;
  readonly left: SideInputs;
  readonly right: SideInputs;
  readonly leftHealth: FeedHealth;
  readonly rightHealth: FeedHealth;
}

export type TickOutcome =
  | { readonly kind: 'IGNORED'; readonly reason: string; readonly state: BattleEngineState }
  | {
      readonly kind: 'UPDATED';
      readonly state: BattleEngineState;
      readonly update: PublicBattleStateUpdate;
    }
  | {
      readonly kind: 'VOIDED';
      readonly state: BattleEngineState;
      readonly reason: VoidReasonCategory;
    };

export function beginBattle(setup: BattleSetup): BattleEngineState {
  return {
    setup,
    state: 'SCHEDULED',
    tickSequence: 0,
    momentum: INITIAL_MOMENTUM_MEMORY,
    evidenceHash: EMPTY_EVIDENCE,
    leftScoreScaled: 0n,
    rightScoreScaled: 0n,
    lastLeft: null,
    lastRight: null,
    lastTickAt: null,
    voidReason: null,
  };
}

/** Moves a scheduled battle live at lock. */
export function openBattle(state: BattleEngineState, at: UtcTimestamp): BattleEngineState {
  if (!canTransitionBattle(state.state, 'LIVE')) {
    throw new Error(`Cannot open a battle in state ${state.state}`);
  }
  if (at < state.setup.clock.battleStartAt) {
    throw new RangeError('A battle cannot open before the scoring window (§12.1)');
  }
  return { ...state, state: 'LIVE' };
}

function cardSupportTier(support: bigint, config: EngineConfig): CardSupportTier {
  const { medium, high, max } = config.cardSupportTiers;
  if (support >= max) return 'MAX';
  if (support >= high) return 'HIGH';
  if (support >= medium) return 'MEDIUM';
  return 'LOW';
}

/**
 * Applies one observation.
 *
 * Three outcomes, and the boundaries between them are the product rules:
 *
 * - **IGNORED** — the tick falls outside the scoring window. §12.6 makes the
 *   cutoff hard: *"stop accepting battle-window data"*. A late sample is
 *   discarded, not blended in.
 * - **VOIDED** — a required feed is `STALE` or `UNAVAILABLE`. §4.4 and Brief §6
 *   are explicit that the engine must not synthesize a result to keep the UI
 *   moving. `DEGRADED` data is late but real and still scores.
 * - **UPDATED** — the score advances and a presentation-safe payload is
 *   produced.
 *
 * The returned update carries no score. §24 and §48.3 forbid publishing it
 * during a live battle, and `PublicBattleStateUpdate` has no field for one.
 */
export function applyTick(
  state: BattleEngineState,
  input: TickInput,
  config: EngineConfig,
): TickOutcome {
  if (state.state !== 'LIVE') {
    return { kind: 'IGNORED', reason: `battle is ${state.state}`, state };
  }

  const { clock } = state.setup;
  if (input.at < clock.battleStartAt) {
    return { kind: 'IGNORED', reason: 'before the scoring window opened', state };
  }
  if (input.at >= clock.battleEndAt) {
    // §12.6: data at or after the hard cutoff is excluded. Not an error — a
    // sample in flight when the window closed is expected, it simply does not
    // count.
    return { kind: 'IGNORED', reason: 'after the hard cutoff', state };
  }
  if (state.lastTickAt !== null && input.at < state.lastTickAt) {
    // Out-of-order samples would make the evidence chain describe a history
    // that never happened.
    return { kind: 'IGNORED', reason: 'older than the last accepted tick', state };
  }

  if (requiresVoid(input.leftHealth) || requiresVoid(input.rightHealth)) {
    const voided: BattleEngineState = {
      ...state,
      state: 'VOID',
      voidReason: 'DATA_INTEGRITY',
    };
    return { kind: 'VOIDED', state: voided, reason: 'DATA_INTEGRITY' };
  }

  const score = scoreBattle(input.left, input.right, config.scoring);
  const sequence = state.tickSequence + 1;
  const evidenceHash = foldEvidence(state.evidenceHash, {
    sequence,
    at: input.at,
    left: input.left,
    right: input.right,
    leftHealth: input.leftHealth,
    rightHealth: input.rightHealth,
    leftScoreScaled: score.leftTotal,
    rightScoreScaled: score.rightTotal,
  });

  const momentum = nextMomentum(
    state.momentum,
    advantageFromBattleScore(score.leftTotal),
    config.momentum,
  );

  const next: BattleEngineState = {
    ...state,
    tickSequence: sequence,
    momentum: momentum.memory,
    evidenceHash,
    leftScoreScaled: score.leftTotal,
    rightScoreScaled: score.rightTotal,
    lastLeft: input.left,
    lastRight: input.right,
    lastTickAt: input.at,
  };

  const totalSupport =
    input.left.cardSupport.market +
    input.left.cardSupport.volume +
    input.left.cardSupport.pons +
    input.left.cardSupport.general +
    input.right.cardSupport.market +
    input.right.cardSupport.volume +
    input.right.cardSupport.pons +
    input.right.cardSupport.general;

  const remaining = clock.battleEndAt - input.at;
  const update: PublicBattleStateUpdate = {
    battleId: state.setup.battleId,
    serverTime: input.at,
    timeRemaining: (remaining > 0 ? remaining : 0) as PublicBattleStateUpdate['timeRemaining'],
    momentum: momentum.state,
    frontline: momentum.frontline,
    intensity: momentum.intensity,
    cardSupport: cardSupportTier(totalSupport, config),
    // §48.3 exposes a coarse indicator only: a client can honestly say data is
    // degraded without learning which vendor is failing.
    feedHealth:
      isScorable(input.leftHealth) &&
      input.leftHealth === 'HEALTHY' &&
      input.rightHealth === 'HEALTHY'
        ? 'HEALTHY'
        : 'DEGRADED',
  };

  return { kind: 'UPDATED', state: next, update };
}

export type FinalizeOutcome =
  | { readonly kind: 'WAIT'; readonly state: BattleEngineState }
  | {
      readonly kind: 'FINALIZED';
      readonly state: BattleEngineState;
      readonly result: FinalizedBattleResult;
    }
  | {
      readonly kind: 'VOIDED';
      readonly state: BattleEngineState;
      readonly reason: VoidReasonCategory;
    };

/**
 * Attempts finalization at or after the hard cutoff.
 *
 * Exactly-once is a property of the state machine, not of the caller: a battle
 * already `FINALIZED` or `VOID` cannot transition again (§22, §25), so a
 * retried finalization is rejected here rather than writing a second result.
 *
 * A battle that never received a scorable tick is voided rather than finalized
 * on zeros. Zero-zero is not a draw, it is an absence of evidence, and §26
 * requires a result to be explicable from what was observed.
 */
export function finalizeBattle(
  state: BattleEngineState,
  at: UtcTimestamp,
  finalizedBlockHash: string,
  config: EngineConfig,
  requiredDataComplete = true,
): FinalizeOutcome {
  if (state.state === 'FINALIZED' || state.state === 'VOID') {
    throw new Error(
      `Battle ${state.setup.battleId} is already ${state.state}; finalization is exactly-once`,
    );
  }
  if (state.state !== 'LIVE') {
    throw new Error(`Cannot finalize a battle in state ${state.state}`);
  }

  const decision = decideFinalization(
    state.setup.clock,
    at,
    requiredDataComplete,
    config.finalization,
  );
  if (decision === 'WAIT') {
    return { kind: 'WAIT', state };
  }
  if (decision === 'VOID') {
    return {
      kind: 'VOIDED',
      state: { ...state, state: 'VOID', voidReason: 'DATA_INTEGRITY' },
      reason: 'DATA_INTEGRITY',
    };
  }

  if (state.tickSequence === 0 || state.lastLeft === null || state.lastRight === null) {
    return {
      kind: 'VOIDED',
      state: { ...state, state: 'VOID', voidReason: 'DATA_INTEGRITY' },
      reason: 'DATA_INTEGRITY',
    };
  }

  const score = scoreBattle(state.lastLeft, state.lastRight, config.scoring);
  const resolution = resolveBattle({
    score,
    left: state.setup.left,
    right: state.setup.right,
    battleId: state.setup.battleId,
    finalizedBlockHash,
  });

  const finalAdvantage = advantageFromBattleScore(score.leftTotal);
  const winnerConfidence =
    resolution.winningSide === 'LEFT' ? state.setup.leftIntel.label : state.setup.rightIntel.label;

  const victoryLabel = classifyVictory({
    margin: resolution.margin,
    winnerConfidence,
    wasComeback: wasComeback(state.momentum, finalAdvantage, config.momentum.comeback),
    thresholds: config.victory,
  });

  const result: FinalizedBattleResult = {
    battleId: state.setup.battleId,
    roundId: state.setup.roundId,
    left: state.setup.left,
    right: state.setup.right,
    winner: resolution.winner,
    leftScore: {
      priceMomentum: Number(score.left.priceMomentum),
      relativeVolume: Number(score.left.relativeVolume),
      ponsPower: Number(score.left.ponsPower),
      holderCardSupport: Number(score.left.holderCardSupport),
    },
    rightScore: {
      priceMomentum: Number(score.right.priceMomentum),
      relativeVolume: Number(score.right.relativeVolume),
      ponsPower: Number(score.right.ponsPower),
      holderCardSupport: Number(score.right.holderCardSupport),
    },
    victoryLabel,
    ...(resolution.tiebreakStep === undefined ? {} : { tiebreakStep: resolution.tiebreakStep }),
    scoringEngineVersion: versionTag(config.versions),
    finalizedAt: at,
    evidenceHash: state.evidenceHash,
  };

  return {
    kind: 'FINALIZED',
    state: {
      ...state,
      state: 'FINALIZED',
      leftScoreScaled: score.leftTotal,
      rightScoreScaled: score.rightTotal,
    },
    result,
  };
}

export { CURRENT_ENGINE_VERSIONS, versionTag };
export type { EngineVersions };
