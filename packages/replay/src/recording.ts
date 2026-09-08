import {
  createRound,
  finalizeRound,
  lockRound,
  tickBattle,
  type EngineConfig,
  type LockedPick,
  type RoundFinalization,
  type TickInput,
} from '@ponswars/battle-engine';
import type { Pairing } from '@ponswars/battle-math';
import type {
  BattleId,
  CanonicalClock,
  ConfidenceLabel,
  RoundId,
  UtcTimestamp,
} from '@ponswars/shared-types';

/**
 * Recording and replaying a round (§26, §54).
 *
 * §26 requires a finalized result to be reproducible from published evidence,
 * and §25 makes a result immutable once finalized. Both promises are only worth
 * as much as the replay path that can demonstrate them, so the replay path is
 * the thing this module builds — and the thing its test attacks.
 *
 * A recording holds every input the engine consumed and nothing it produced.
 * That distinction is the whole point: a recording that carried results could
 * "reproduce" them by handing them back.
 */

/** One battle's ordered scoring ticks. */
export interface BattleTickLog {
  readonly battleId: BattleId;
  readonly ticks: readonly TickInput[];
}

/**
 * Everything needed to replay one round, and nothing else.
 *
 * Deliberately free of results, scores, winners and awards. What the engine
 * produced is the thing under test; what it consumed is the recording.
 */
export interface RoundRecording {
  readonly roundId: RoundId;
  readonly roundIndex: number;
  readonly clock: CanonicalClock;
  readonly baseSeedHex: string;
  readonly recentRounds: readonly (readonly Pairing[])[];
  readonly confidence: Readonly<Record<string, ConfidenceLabel>>;
  readonly picks: readonly LockedPick[];
  /** Ticks in the order they were applied. Order is part of the record (§26). */
  readonly tickLogs: readonly BattleTickLog[];
  readonly finalizationBlockHash: string;
  /**
   * The engine tuning in force when the round ran (§59.4).
   *
   * Part of the record, not a parameter. §26 promises a result is reproducible
   * from published evidence, and the same inputs under different calibration
   * produce a different result — so a replay that accepted a config from its
   * caller could "reproduce" a round under tuning that round never saw, and two
   * people replaying the same file would disagree while both believed they had
   * verified it.
   *
   * `scoringEngineVersion` on the result versions the code. This versions the
   * numbers the code was given.
   */
  readonly config: EngineConfig;
}

/**
 * Runs a round from a recording.
 *
 * The single code path: the recorder produces a recording *and* runs it through
 * this, so a live round and its replay cannot diverge by being two
 * implementations of the same sequence. A replay that used its own runner would
 * be testing the runner, not the engine.
 */
export function replayRound(recording: RoundRecording): RoundFinalization {
  const config = recording.config;
  const round = createRound({
    roundId: recording.roundId,
    roundIndex: recording.roundIndex,
    clock: recording.clock,
    baseSeedHex: recording.baseSeedHex,
    recentRounds: recording.recentRounds,
    confidence: recording.confidence,
  });

  let state = lockRound(round, recording.clock.lockAt, recording.picks);

  // Ticks are applied in exactly the recorded order. Reordering them across
  // battles would still be "the same inputs" in a loose sense and could still
  // produce a different chained evidence hash (§26), which is precisely the
  // kind of divergence a replay exists to catch.
  for (const log of recording.tickLogs) {
    for (const tick of log.ticks) {
      state = tickBattle(state, log.battleId, tick, config);
    }
  }

  return finalizeRound(state, recording.clock.battleEndAt, recording.finalizationBlockHash, config);
}

/**
 * A recording paired with the outcome the recorder observed.
 *
 * Kept together only so a test can compare them. Nothing in the replay path
 * reads `outcome`.
 */
export interface RecordedRound {
  readonly recording: RoundRecording;
  readonly outcome: RoundFinalization;
}

/**
 * Records a round while running it.
 *
 * The tick inputs are supplied by the caller through `tickFor`, which is where a
 * market feed — synthetic today, historical when the vendor is chosen — plugs
 * in. The recorder does not know or care which it is, and that is what makes a
 * historical replay the same exercise as a synthetic one.
 */
export function recordRound(input: {
  readonly roundId: RoundId;
  readonly roundIndex: number;
  readonly clock: CanonicalClock;
  readonly baseSeedHex: string;
  readonly recentRounds: readonly (readonly Pairing[])[];
  readonly confidence: Readonly<Record<string, ConfidenceLabel>>;
  readonly picks: readonly LockedPick[];
  readonly finalizationBlockHash: string;
  readonly tickCount: number;
  readonly tickFor: (
    battleId: BattleId,
    left: string,
    right: string,
    tickIndex: number,
    at: UtcTimestamp,
  ) => TickInput;
  readonly config: EngineConfig;
}): RecordedRound {
  const round = createRound({
    roundId: input.roundId,
    roundIndex: input.roundIndex,
    clock: input.clock,
    baseSeedHex: input.baseSeedHex,
    recentRounds: input.recentRounds,
    confidence: input.confidence,
  });

  const locked = lockRound(round, input.clock.lockAt, input.picks);

  // Build the whole tick log up front, then replay it. The recorder is a thin
  // wrapper over `replayRound` rather than a second implementation — if the two
  // could drift, a passing replay would prove nothing.
  const tickLogs: BattleTickLog[] = locked.battles.map((battle) => {
    const ticks: TickInput[] = [];
    for (let tickIndex = 0; tickIndex < input.tickCount; tickIndex += 1) {
      const at = (input.clock.battleStartAt + (tickIndex + 1) * 60_000 - 1_000) as UtcTimestamp;
      ticks.push(
        input.tickFor(battle.setup.battleId, battle.setup.left, battle.setup.right, tickIndex, at),
      );
    }
    return { battleId: battle.setup.battleId, ticks };
  });

  const recording: RoundRecording = {
    roundId: input.roundId,
    roundIndex: input.roundIndex,
    clock: input.clock,
    baseSeedHex: input.baseSeedHex,
    recentRounds: input.recentRounds,
    confidence: input.confidence,
    picks: input.picks,
    tickLogs,
    finalizationBlockHash: input.finalizationBlockHash,
    config: input.config,
  };

  return { recording, outcome: replayRound(recording) };
}

/**
 * Serializes a recording to JSON.
 *
 * A recording travels between a producer and a replay tool, so it has to
 * survive a file. `bigint` has no JSON representation and would throw here
 * rather than silently losing precision — the tick inputs carry scaled integer
 * ratios (ADR 0003), so the encoding is explicit about them.
 */
export function encodeRecording(recording: RoundRecording): string {
  return JSON.stringify(recording, (_key, value: unknown) =>
    typeof value === 'bigint' ? { $bigint: value.toString() } : value,
  );
}

/**
 * Reads back what {@link encodeRecording} wrote.
 *
 * A recording arriving as a file is external input, and §66.2 does not make an
 * exception for a file this repo also writes — a truncated download or an
 * edited field would otherwise reach the engine as a plausible-looking round.
 * The shape check below is deliberately shallow: it establishes that the
 * required fields exist and have the right kind, and the engine's own
 * validation covers the values.
 */
export function decodeRecording(json: string): RoundRecording {
  const parsed: unknown = JSON.parse(json, (_key, value: unknown) => {
    if (typeof value === 'object' && value !== null && '$bigint' in value) {
      const encoded = value.$bigint;
      if (typeof encoded === 'string') {
        return BigInt(encoded);
      }
    }
    return value;
  });

  assertRecordingShape(parsed);
  return parsed;
}

/** Fields a recording cannot replay without. */
const REQUIRED_RECORDING_FIELDS = [
  'roundId',
  'roundIndex',
  'clock',
  'baseSeedHex',
  'recentRounds',
  'confidence',
  'picks',
  'tickLogs',
  'finalizationBlockHash',
  'config',
] as const;

function assertRecordingShape(value: unknown): asserts value is RoundRecording {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('A recording must be an object');
  }
  const record = value as Record<string, unknown>;

  for (const field of REQUIRED_RECORDING_FIELDS) {
    if (!(field in record)) {
      throw new TypeError(`A recording is missing ${field}`);
    }
  }
  if (typeof record['baseSeedHex'] !== 'string') {
    throw new TypeError('A recording needs a base seed');
  }
  if (typeof record['roundIndex'] !== 'number' || !Number.isInteger(record['roundIndex'])) {
    throw new TypeError('A round index is a whole number');
  }
  if (!Array.isArray(record['tickLogs']) || !Array.isArray(record['picks'])) {
    throw new TypeError('A recording carries tick logs and picks as arrays');
  }
}
