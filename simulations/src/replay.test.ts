import { clockForRound, roundIdFor } from '@ponswars/battle-math';
import { type ActiveTicker, type RoundId } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  CONFIDENCE_LABELS_BY_TICKER,
  CONFIG,
  EPOCH,
  SEED,
  TICKS_PER_BATTLE,
} from './harness.js';
import { observe } from './market.js';
import {
  decodeRecording,
  encodeRecording,
  recordRound,
  replayRound,
  type RecordedRound,
} from '@ponswars/replay';

/**
 * Replay fidelity (§26, §25).
 *
 * §26 requires a finalized result to be reproducible from published evidence,
 * and §25 makes it immutable once finalized. A test that only replays the happy
 * path proves neither — it would pass just as well against an engine that
 * ignored its inputs. So these also change one recorded input at a time and
 * insist the result moves.
 */

const ROUND_INDEX = 7;
const CLOCK = clockForRound(EPOCH, ROUND_INDEX, EPOCH);
const ROUND_ID = roundIdFor(ROUND_INDEX) as RoundId;

function record(marketSeed = SEED): RecordedRound {
  return recordRound({
    roundId: ROUND_ID,
    roundIndex: ROUND_INDEX,
    clock: CLOCK,
    baseSeedHex: SEED,
    recentRounds: [],
    confidence: CONFIDENCE_LABELS_BY_TICKER,
    // Picks reference real battle ids only once the round exists; an id that
    // matches nothing is simply not counted, which keeps this focused on tick
    // fidelity rather than on pick routing.
    picks: [],
    finalizationBlockHash: BLOCK,
    tickCount: TICKS_PER_BATTLE,
    tickFor: (_battleId, left, right, tickIndex, at) => {
      // The recorder passes the tickers the schedule produced, so the cast only
      // restores what the roster already guarantees.
      const leftSide = observe(marketSeed, ROUND_INDEX, tickIndex, left as ActiveTicker);
      const rightSide = observe(marketSeed, ROUND_INDEX, tickIndex, right as ActiveTicker);
      return {
        at,
        left: leftSide.inputs,
        right: rightSide.inputs,
        leftHealth: leftSide.health,
        rightHealth: rightSide.health,
      };
    },
    config: CONFIG,
  });
}

describe('replaying a recording', () => {
  it('reproduces the result exactly', () => {
    const recorded = record();
    const replayed = replayRound(recorded.recording);
    expect(replayed.results).toEqual(recorded.outcome.results);
    expect(replayed.voided).toEqual(recorded.outcome.voided);
    expect(replayed.awards).toEqual(recorded.outcome.awards);
  });

  it('reproduces the evidence hash, which is what §26 actually promises', () => {
    const recorded = record();
    const replayed = replayRound(recorded.recording);
    for (const [index, result] of replayed.results.entries()) {
      expect(result.evidenceHash).toBe(recorded.outcome.results[index]?.evidenceHash);
    }
  });

  it('is stable across repeated replays', () => {
    const recorded = record();
    const first = replayRound(recorded.recording);
    const second = replayRound(recorded.recording);
    expect(second.results).toEqual(first.results);
  });

  it('survives a round trip through JSON', () => {
    // A recording travels between a producer and a replay tool, so it has to
    // survive a file. The tick inputs carry scaled integer ratios, and a
    // `bigint` that quietly became a string would replay to a different result.
    const recorded = record();
    const decoded = decodeRecording(encodeRecording(recorded.recording));
    expect(replayRound(decoded).results).toEqual(recorded.outcome.results);
  });

  it('refuses a recording that lost a field on the way in', () => {
    // §66.2 makes no exception for a file this repo also wrote: a truncated
    // download would otherwise reach the engine as a plausible-looking round.
    const recorded = record();
    const withoutSeed = { ...recorded.recording } as Record<string, unknown>;
    delete withoutSeed['baseSeedHex'];
    expect(() => decodeRecording(JSON.stringify(withoutSeed))).toThrow(TypeError);
    expect(() => decodeRecording('null')).toThrow(TypeError);
    expect(() =>
      decodeRecording(JSON.stringify({ ...recorded.recording, roundIndex: 1.5 })),
    ).toThrow(TypeError);
  });

  it('carries no results of its own to hand back', () => {
    // A recording that held the outcome could "reproduce" it trivially. The
    // keys are pinned so a later field cannot smuggle one in.
    expect(Object.keys(record().recording).sort()).toEqual([
      'baseSeedHex',
      'clock',
      'confidence',
      'config',
      'finalizationBlockHash',
      'picks',
      'recentRounds',
      'roundId',
      'roundIndex',
      'tickLogs',
    ]);
  });
});

describe('the recorded tuning', () => {
  it('travels with the recording rather than being supplied by the caller', () => {
    // §26 promises a result is reproducible from published evidence. The same
    // inputs under different calibration produce a different result, so a
    // replay that took a config from its caller could "reproduce" a round under
    // tuning that round never saw — and two people replaying the same file
    // would disagree while both believed they had verified it.
    const recorded = record();
    expect(recorded.recording.config).toBeDefined();
    expect(recorded.recording.config.versions).toEqual(CONFIG.versions);
  });

  it('survives the JSON round trip with its bigints intact', () => {
    // The scoring divisors are scaled bigints. One that came back as a string
    // would replay to a different score without anything looking wrong.
    const decoded = decodeRecording(encodeRecording(record().recording));
    expect(decoded.config.scoring.priceEdgeDivisor).toBe(CONFIG.scoring.priceEdgeDivisor);
    expect(typeof decoded.config.scoring.priceEdgeDivisor).toBe('bigint');
  });

  it('is refused when missing', () => {
    const recorded = record();
    const withoutConfig = { ...recorded.recording } as Record<string, unknown>;
    delete withoutConfig['config'];
    expect(() => decodeRecording(JSON.stringify(withoutConfig))).toThrow(TypeError);
  });
});

describe('a replay that should diverge', () => {
  it('produces a different result from different market data', () => {
    // The control for every test above: if the engine ignored its inputs, they
    // would all pass anyway.
    const original = record();
    const different = record(`0x${'a7'.repeat(32)}`);
    expect(different.outcome.results).not.toEqual(original.outcome.results);
  });

  it('changes the evidence hash when a single tick is altered', () => {
    const recorded = record();
    const [firstLog, ...restLogs] = recorded.recording.tickLogs;
    if (firstLog === undefined) {
      throw new Error('The recording has no tick logs');
    }
    const [firstTick, ...restTicks] = firstLog.ticks;
    if (firstTick === undefined) {
      throw new Error('The first battle has no ticks');
    }

    const tampered = {
      ...recorded.recording,
      tickLogs: [
        {
          ...firstLog,
          ticks: [
            {
              ...firstTick,
              left: { ...firstTick.left, windowReturn: firstTick.left.windowReturn + 1n },
            },
            ...restTicks,
          ],
        },
        ...restLogs,
      ],
    };

    const replayed = replayRound(tampered);
    const originalHash = recorded.outcome.results.find(
      (result) => result.battleId === firstLog.battleId,
    )?.evidenceHash;
    const tamperedHash = replayed.results.find(
      (result) => result.battleId === firstLog.battleId,
    )?.evidenceHash;

    expect(originalHash).toBeDefined();
    expect(tamperedHash).toBeDefined();
    expect(tamperedHash).not.toBe(originalHash);
  });

  it('changes the schedule when the base seed changes', () => {
    // Matchmaking is seeded (§4.3), so a different seed is a different round —
    // and a replay that produced the original pairings anyway would mean the
    // seed was not really an input.
    const recorded = record();
    const different = replayRound({
      ...recorded.recording,
      baseSeedHex: `0x${'3b'.repeat(32)}`,
    });
    const originalPairs = recorded.outcome.results.map(
      (result) => `${result.left}/${result.right}`,
    );
    const differentPairs = different.results.map((result) => `${result.left}/${result.right}`);
    expect(differentPairs).not.toEqual(originalPairs);
  });
});
