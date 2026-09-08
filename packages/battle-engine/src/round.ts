import { battleIdFor, scheduleRound, sectorIdFor, type Pairing } from '@ponswars/battle-math';
import {
  BATTLES_PER_ROUND,
  canTransitionRound,
  winningPickWp,
  type ActiveTicker,
  type BattleId,
  type CanonicalClock,
  type ConfidenceLabel,
  type FinalizedBattleResult,
  type RoundId,
  type RoundState,
  type UtcTimestamp,
  type WalletAddress,
  type WpAwardReason,
} from '@ponswars/shared-types';
import {
  applyTick,
  beginBattle,
  finalizeBattle,
  openBattle,
  type BattleEngineState,
  type EngineConfig,
  type TickInput,
} from './engine.js';

/**
 * Round orchestration (§22, §68).
 *
 * Drives the five simultaneous battles of a round through the locked state
 * machine and, on successful finalization, produces the War Point awards.
 *
 * Like the battle engine it wraps, this is a reducer: no clock, no I/O. The
 * canonical end-to-end flow in §68 — pick, lock, live battle, finalize, award —
 * is expressible as a sequence of pure calls, which is what makes it testable
 * end to end without a database or a feed.
 */

/** A player's locked pick (§49.8). One per wallet per round. */
export interface LockedPick {
  readonly wallet: WalletAddress;
  readonly battleId: BattleId;
  readonly backedTicker: ActiveTicker;
  readonly cardDeployed: boolean;
}

/** A War Point award produced by finalization (§11, §49.10). */
export interface WpAward {
  readonly wallet: WalletAddress;
  readonly battleId: BattleId;
  readonly reason: WpAwardReason;
  readonly points: number;
}

export interface RoundEngineState {
  readonly roundId: RoundId;
  readonly state: RoundState;
  readonly clock: CanonicalClock;
  readonly battles: readonly BattleEngineState[];
  /**
   * Picks accepted during Pick Phase, frozen at lock.
   *
   * Empty until `lockRound`. §22 allows pick mutation only while `PICK_OPEN`,
   * so the engine never sees a pick it could still change.
   */
  readonly picks: readonly LockedPick[];
  readonly matchmakingSeed: string;
}

export interface RoundSetup {
  readonly roundId: RoundId;
  readonly roundIndex: number;
  readonly clock: CanonicalClock;
  readonly baseSeedHex: string;
  readonly roster?: readonly ActiveTicker[];
  readonly recentRounds?: readonly (readonly Pairing[])[];
  /**
   * Battle Confidence per ticker, snapshotted when the round opened (§10.1).
   *
   * Required for every participating ticker: §11 derives the upset award from
   * the winner's label, and a missing entry would silently downgrade an upset
   * to an ordinary win.
   */
  readonly confidence: Readonly<Record<string, ConfidenceLabel>>;
}

/**
 * Creates a round with its five matchups.
 *
 * Matchmaking is deterministic and verifiable from the seed and round context
 * (§4.3), so two nodes creating the same round produce the same pairings and a
 * third party can check them.
 */
export function createRound(setup: RoundSetup): RoundEngineState {
  const pairings = scheduleRound({
    baseSeedHex: setup.baseSeedHex,
    roundId: setup.roundId,
    ...(setup.roster === undefined ? {} : { roster: setup.roster }),
    ...(setup.recentRounds === undefined ? {} : { recentRounds: setup.recentRounds }),
  });

  const battles = pairings.map((pairing, slot) => {
    const leftConfidence = setup.confidence[pairing.left];
    const rightConfidence = setup.confidence[pairing.right];
    if (leftConfidence === undefined || rightConfidence === undefined) {
      throw new RangeError(
        `Missing Battle Confidence for ${pairing.left} or ${pairing.right}; ` +
          'an absent label would silently downgrade an upset to an ordinary win (§11)',
      );
    }
    return beginBattle({
      battleId: battleIdFor(setup.roundIndex, slot) as BattleId,
      roundId: setup.roundId,
      left: pairing.left,
      right: pairing.right,
      clock: setup.clock,
      leftConfidence,
      rightConfidence,
    });
  });

  return {
    roundId: setup.roundId,
    state: 'PICK_OPEN',
    clock: setup.clock,
    battles,
    picks: [],
    matchmakingSeed: setup.baseSeedHex,
  };
}

/** The five sector ids a round occupies. Neutral and reused (§38.3). */
export function sectorIds(): readonly string[] {
  return Array.from({ length: BATTLES_PER_ROUND }, (_, slot) => sectorIdFor(slot));
}

/**
 * Locks the round and opens every battle.
 *
 * §3.2 consumes deployed card charges here, transactionally. That write belongs
 * to the Player service, not to this reducer — what the engine records is the
 * frozen pick set the result will be scored against.
 *
 * @throws RangeError if a wallet appears twice. §49.8 makes one pick per wallet
 *   per round a database constraint; enforcing it here too means a bug upstream
 *   surfaces before it can double-award War Points.
 */
export function lockRound(
  state: RoundEngineState,
  at: UtcTimestamp,
  picks: readonly LockedPick[],
): RoundEngineState {
  if (!canTransitionRound(state.state, 'LOCKING')) {
    throw new Error(`Cannot lock a round in state ${state.state}`);
  }
  if (at < state.clock.lockAt) {
    throw new RangeError('A round cannot lock before its lock instant (§3.2)');
  }

  const seen = new Set<WalletAddress>();
  const battleIds = new Set(state.battles.map((battle) => battle.setup.battleId));
  for (const pick of picks) {
    if (seen.has(pick.wallet)) {
      throw new RangeError(`Wallet ${pick.wallet} has two picks in round ${state.roundId}`);
    }
    seen.add(pick.wallet);
    if (!battleIds.has(pick.battleId)) {
      throw new RangeError(`Pick references battle ${pick.battleId}, which is not in this round`);
    }
  }

  return {
    ...state,
    state: 'BATTLE_LIVE',
    picks,
    battles: state.battles.map((battle) => openBattle(battle, at)),
  };
}

/** Applies one observation to a single battle, leaving the others untouched. */
export function tickBattle(
  state: RoundEngineState,
  battleId: BattleId,
  input: TickInput,
  config: EngineConfig,
): RoundEngineState {
  return {
    ...state,
    battles: state.battles.map((battle) =>
      battle.setup.battleId === battleId ? applyTick(battle, input, config).state : battle,
    ),
  };
}

export interface RoundFinalization {
  readonly state: RoundEngineState;
  readonly results: readonly FinalizedBattleResult[];
  /** Battles that could not be scored (§4.4). */
  readonly voided: readonly BattleId[];
  readonly awards: readonly WpAward[];
}

/**
 * Finalizes every battle and awards War Points.
 *
 * A VOID battle produces no result, no award and **no loss** (§4.4, §11) — its
 * pickers are simply absent from the award list, and the card refund is the
 * Player service's job.
 *
 * §22 writes War Points only during successful finalization, so this is the
 * single place they originate.
 */
export function finalizeRound(
  state: RoundEngineState,
  at: UtcTimestamp,
  finalizedBlockHash: string,
  config: EngineConfig,
  requiredDataComplete = true,
): RoundFinalization {
  if (!canTransitionRound(state.state, 'FINALIZING')) {
    throw new Error(`Cannot finalize a round in state ${state.state}`);
  }

  const battles: BattleEngineState[] = [];
  const results: FinalizedBattleResult[] = [];
  const voided: BattleId[] = [];

  for (const battle of state.battles) {
    if (battle.state === 'VOID') {
      battles.push(battle);
      voided.push(battle.setup.battleId);
      continue;
    }

    const outcome = finalizeBattle(battle, at, finalizedBlockHash, config, requiredDataComplete);
    battles.push(outcome.state);
    if (outcome.kind === 'FINALIZED') {
      results.push(outcome.result);
    } else if (outcome.kind === 'VOIDED') {
      voided.push(battle.setup.battleId);
    }
  }

  // A round that could not finalize every battle is not finalized. WAIT leaves
  // it in FINALIZING so the caller can retry within the §72.5 window.
  const settled = results.length + voided.length === state.battles.length;

  const awards = settled ? awardsFor(state, results) : [];

  return {
    state: {
      ...state,
      state: settled ? 'FINALIZED' : 'FINALIZING',
      battles,
    },
    results,
    voided,
    awards,
  };
}

/**
 * War Point awards for a set of results (§11).
 *
 * The base award and the Card Assist are emitted as **separate** entries.
 * §49.10 makes the ledger idempotent on `(wallet, battle, reason)`, and one
 * combined row would collapse two reasons into one — losing the ability to tell
 * a 12-point underdog win from a 10-point win with a card.
 */
function awardsFor(
  state: RoundEngineState,
  results: readonly FinalizedBattleResult[],
): readonly WpAward[] {
  const byBattle = new Map<BattleId, FinalizedBattleResult>();
  for (const result of results) {
    byBattle.set(result.battleId, result);
  }

  const awards: WpAward[] = [];
  for (const pick of state.picks) {
    const result = byBattle.get(pick.battleId);
    if (result === undefined || result.winner !== pick.backedTicker) {
      // A loss earns nothing, and a VOID earns nothing while recording no loss
      // (§11). Both are the absence of an award.
      continue;
    }

    const battle = state.battles.find((candidate) => candidate.setup.battleId === pick.battleId);
    /* c8 ignore next 3 -- unreachable: picks are validated against the round at lock. */
    if (battle === undefined) {
      continue;
    }
    const winnerConfidence =
      result.winner === battle.setup.left
        ? battle.setup.leftConfidence
        : battle.setup.rightConfidence;

    const base = winningPickWp(winnerConfidence, false);
    const reason: WpAwardReason =
      winnerConfidence === 'HEAVY_UNDERDOG'
        ? 'HEAVY_UNDERDOG_WIN'
        : winnerConfidence === 'UNDERDOG'
          ? 'UNDERDOG_WIN'
          : 'WIN';

    awards.push({ wallet: pick.wallet, battleId: pick.battleId, reason, points: base });

    if (pick.cardDeployed) {
      awards.push({
        wallet: pick.wallet,
        battleId: pick.battleId,
        reason: 'CARD_ASSIST',
        points: winningPickWp(winnerConfidence, true) - base,
      });
    }
  }
  return awards;
}
