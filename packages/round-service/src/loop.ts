import {
  applyTick,
  finalizeRound,
  lockRound,
  nextRoundAction,
  type BattleEngineState,
  type EngineConfig,
  type RoundAction,
  type RoundEngineState,
  type RoundFinalization,
} from '@ponswars/battle-engine';
import { battleChannel, roundChannel } from '@ponswars/realtime';
import type { UtcTimestamp } from '@ponswars/shared-types';
import type { RoundPorts } from './ports.js';

/**
 * One turn of the round loop (§68).
 *
 * `nextRoundAction` decides what is due; this performs it. Splitting them that
 * way is what keeps the schedule testable without IO and the IO testable
 * without a clock — and it means a service is a `while` loop around one call
 * rather than a place where the timing rules get re-derived.
 *
 * The step is idempotent in the way that matters: asking twice at the same
 * instant either performs the same transition twice on a state machine that
 * refuses the second, or does nothing at all. Nothing here decides that a round
 * should void, and nothing retries a failed finalization silently.
 */

export interface StepResult {
  readonly state: RoundEngineState;
  /** What the driver said was due, for logging and for the caller's sleep. */
  readonly action: RoundAction;
  /** Present only on the step that finalized the round. */
  readonly finalization?: RoundFinalization;
}

export async function stepRound(
  state: RoundEngineState,
  now: UtcTimestamp,
  ports: RoundPorts,
  config: EngineConfig,
): Promise<StepResult> {
  const action = nextRoundAction(state, now, config.finalization.maxWait);

  switch (action.kind) {
    case 'WAIT':
    case 'ACCEPT_PICKS':
    case 'DONE':
      // Nothing to perform. Submissions during `ACCEPT_PICKS` arrive through
      // the API, not through this loop — the loop's job is the boundary, and
      // the boundary is `LOCK`.
      return { state, action };

    case 'FINALIZATION_OVERDUE':
      // Surfaced, not acted on. §61 principle 19 makes voiding a decision about
      // data; a loop that voided on a timer would void rounds because a
      // database was slow.
      return { state, action };

    case 'LOCK':
      return { state: await performLock(state, ports), action };

    case 'TICK':
      return { state: await performTick(state, now, ports, config), action };

    case 'FINALIZE': {
      const finalization = await performFinalize(state, ports, config);
      return { state: finalization.state, action, finalization };
    }
  }
}

/**
 * Locks picks and opens the battle (§3.2, §22).
 *
 * Locks at `clock.lockAt` rather than at `now`. The lock instant is a property
 * of the round, not of when the loop got around to it — a service that ran
 * three seconds late would otherwise record a lock three seconds late and give
 * a late pick a window it never had.
 */
async function performLock(state: RoundEngineState, ports: RoundPorts): Promise<RoundEngineState> {
  const picks = await ports.picks.lockedPicks(state.roundId);
  const locked = lockRound(state, state.clock.lockAt, picks);

  await ports.store.saveState(locked);
  await ports.publisher.publish('ROUND_LOCKED', roundChannel(state.roundId), state.clock.lockAt, {
    roundId: state.roundId,
    battles: locked.battles.map((battle) => ({
      battleId: battle.setup.battleId,
      left: battle.setup.left,
      right: battle.setup.right,
    })),
  });

  return locked;
}

/**
 * Scores one observation for every battle (§12).
 *
 * Both sides of a battle are observed at the same instant. Observing them
 * sequentially against a moving clock would compare a slightly later window for
 * one side than the other, which §12.1 rules out by defining the window once
 * for the battle rather than per ticker.
 *
 * A battle whose observation fails is skipped, not guessed at. The engine
 * already voids a battle that reaches its cutoff with nothing scorable, so
 * dropping a tick degrades toward that rather than around it.
 */
async function performTick(
  state: RoundEngineState,
  now: UtcTimestamp,
  ports: RoundPorts,
  config: EngineConfig,
): Promise<RoundEngineState> {
  const battles: BattleEngineState[] = [];
  const toPublish: { readonly battleId: string; readonly update: unknown }[] = [];

  for (const battle of state.battles) {
    const [left, right] = await Promise.all([
      ports.marketData.observe(battle.setup.left, now),
      ports.marketData.observe(battle.setup.right, now),
    ]);

    const outcome = applyTick(
      battle,
      {
        at: now,
        left: left.inputs,
        right: right.inputs,
        leftHealth: left.health,
        rightHealth: right.health,
      },
      config,
    );
    battles.push(outcome.state);

    // Only an `UPDATED` tick has anything to say. Publishing an ignored one
    // would burn a sequence number and tell every subscriber that something
    // happened when nothing did — and §70.7 teaches clients to treat a
    // sequence as meaningful.
    //
    // The payload is the engine's own `PublicBattleStateUpdate`, not a shape
    // assembled here. §24 forbids sending the hidden score during a live
    // battle, and the type that carries this has no score field at all — so
    // the safe payload is the one the engine already built.
    if (outcome.kind === 'UPDATED') {
      toPublish.push({ battleId: battle.setup.battleId, update: outcome.update });
    }
  }

  const next: RoundEngineState = { ...state, battles };

  // Persist before publishing. A subscriber told about a frontline the server
  // would lose on restart has been told something that is about to stop being
  // true.
  await ports.store.saveState(next);
  for (const item of toPublish) {
    await ports.publisher.publish(
      'BATTLE_STATE_UPDATE',
      battleChannel(item.battleId),
      now,
      item.update,
    );
  }

  return next;
}

/**
 * Finalizes the round exactly once (§25, §66.6).
 *
 * Persists before publishing. A result announced but not stored is a result
 * that disappears on the next restart, and §25 makes it immutable from the
 * moment it exists — so it has to exist durably first.
 *
 * Finalizes at `clock.battleEndAt` rather than `now`, for the same reason the
 * lock uses `clock.lockAt`: §12.6's cutoff belongs to the round, not to the
 * loop's punctuality.
 */
async function performFinalize(
  state: RoundEngineState,
  ports: RoundPorts,
  config: EngineConfig,
): Promise<RoundFinalization> {
  const blockHash = await ports.chain.finalizationBlockHash(state.clock.battleEndAt);
  const finalization = finalizeRound(state, state.clock.battleEndAt, blockHash, config);

  await ports.store.saveFinalization(finalization);
  await ports.publisher.publish(
    'ROUND_FINALIZED',
    roundChannel(state.roundId),
    state.clock.battleEndAt,
    {
      roundId: state.roundId,
      results: finalization.results,
      voided: finalization.voided,
    },
  );

  return finalization;
}
