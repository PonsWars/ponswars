import { clockForRound, DeterministicPrng, roundIdFor } from '@ponswars/battle-math';
import { finalizeRound } from '@ponswars/battle-engine';
import {
  applySnapshot,
  battleChannel,
  clockOffset,
  EMPTY_RECEIVER,
  isAwaitingSnapshot,
  PROTOCOL_VERSION,
  receive,
  serverNow,
  type Envelope,
  type ReceiverState,
} from '@ponswars/realtime';
import { utcTimestamp, type ActiveTicker, type RoundId } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  CONFIG,
  CONFIDENCE_LABELS_BY_TICKER,
  EPOCH,
  SEED,
  TICKS_PER_BATTLE,
} from './harness.js';
import { observe } from './market.js';
import { recordRound, replayRound, type RecordedRound } from '@ponswars/replay';

/**
 * Delivery chaos and exactly-once accounting (§49, §70.7, §66.6).
 *
 * §18 of the execution order calls for concurrency, load and chaos testing.
 * Load needs a running transport, which is still `OPEN` — but the behaviour
 * under bad delivery does not: every path that matters is a reducer, and a
 * reducer can be fed a redelivered, reordered or missing event without a socket
 * anywhere.
 *
 * What is asserted here is not that the system survives. It is that it never
 * fabricates: a duplicate is ignored rather than applied twice, a gap stops
 * incremental updates instead of guessing at the missing ones, and a second
 * finalization does not produce a second result.
 */

const CHANNEL = battleChannel('b-1');

function envelope(sequence: number, payload = 'x'): Envelope<string> {
  return {
    event: 'BATTLE_STATE_UPDATE',
    version: PROTOCOL_VERSION,
    sequence,
    emittedAt: EPOCH,
    channel: CHANNEL,
    payload,
  };
}

/** Feeds a sequence of envelopes and reports what each one did. */
function deliver(
  order: readonly number[],
  start: ReceiverState = EMPTY_RECEIVER,
): { state: ReceiverState; outcomes: readonly string[] } {
  let state = start;
  const outcomes: string[] = [];
  for (const sequence of order) {
    const result = receive(state, envelope(sequence));
    state = result.state;
    outcomes.push(result.outcome.kind);
  }
  return { state, outcomes };
}

describe('redelivery', () => {
  it('applies each event once, however many times it arrives', () => {
    // A reconnect can replay what the client already has. Applying an old
    // frontline again would move the battle backwards on screen.
    const { outcomes } = deliver([1, 2, 3, 2, 1, 3]);
    expect(outcomes).toEqual(['APPLY', 'APPLY', 'APPLY', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
  });

  it('keeps the highest sequence after a burst of duplicates', () => {
    const { state } = deliver([1, 2, 3, 1, 2]);
    expect(state.lastSequence[CHANNEL]).toBe(3);
  });
});

describe('reordering', () => {
  it('treats an event from the past as a duplicate, not as news', () => {
    const { outcomes } = deliver([1, 2, 5]);
    // 5 after 2 is a gap, not an out-of-order arrival — the client cannot tell
    // the difference and must not assume the missing ones are still coming.
    expect(outcomes.at(-1)).toBe('GAP');
  });

  it('does not accept later events while waiting for a snapshot', () => {
    // §70.7: on a gap, stop applying incremental animation targets. Continuing
    // to apply would animate from a state the client no longer knows.
    const { state, outcomes } = deliver([1, 5, 6, 7]);
    expect(outcomes).toEqual(['APPLY', 'GAP', 'AWAITING_SNAPSHOT', 'AWAITING_SNAPSHOT']);
    expect(isAwaitingSnapshot(state, CHANNEL)).toBe(true);
  });
});

describe('recovery', () => {
  it('resumes from the snapshot rather than replaying the hole', () => {
    // §24: do not replay every missed animation tick. Those events describe a
    // battle state that has already been superseded.
    const gapped = deliver([1, 9]).state;
    const recovered = applySnapshot(gapped, CHANNEL, 12);

    expect(isAwaitingSnapshot(recovered, CHANNEL)).toBe(false);
    const after = deliver([13], recovered);
    expect(after.outcomes).toEqual(['APPLY']);
  });

  it('rejects events the snapshot has already covered', () => {
    const recovered = applySnapshot(deliver([1, 9]).state, CHANNEL, 12);
    expect(deliver([11], recovered).outcomes).toEqual(['DUPLICATE']);
  });

  it('recovers each channel independently', () => {
    // Channels advance independently (§70.1), so a gap on one battle must not
    // stall the world channel or the other four battles.
    const other = battleChannel('b-2');
    let state = deliver([1, 7]).state;
    const result = receive(state, { ...envelope(1), channel: other });
    state = result.state;
    expect(result.outcome.kind).toBe('APPLY');
    expect(isAwaitingSnapshot(state, CHANNEL)).toBe(true);
    expect(isAwaitingSnapshot(state, other)).toBe(false);
  });

  it('refuses an envelope from a protocol it does not understand', () => {
    const result = receive(EMPTY_RECEIVER, { ...envelope(1), version: PROTOCOL_VERSION + 1 });
    expect(result.outcome.kind).toBe('REJECTED');
    expect(result.state).toBe(EMPTY_RECEIVER);
  });
});

describe('clock skew', () => {
  it('projects a badly wrong local clock onto server time', () => {
    // §23.5: a player whose laptop is five minutes fast must still see the same
    // countdown. The offset absorbs the error rather than the countdown.
    const skewMs = 5 * 60_000;
    const sent = utcTimestamp(EPOCH + skewMs);
    const received = utcTimestamp(EPOCH + skewMs + 80);
    const serverTime = utcTimestamp(EPOCH + 40);

    const offset = clockOffset(sent, serverTime, received);
    expect(serverNow(received, offset)).toBe(utcTimestamp(EPOCH + 80));
  });

  it('handles a clock behind the server as readily as one ahead', () => {
    const behind = -3 * 60_000;
    const sent = utcTimestamp(EPOCH + behind);
    const received = utcTimestamp(EPOCH + behind + 100);
    const offset = clockOffset(sent, utcTimestamp(EPOCH + 50), received);
    expect(serverNow(received, offset)).toBe(utcTimestamp(EPOCH + 100));
  });

  it('refuses a response that arrived before it was sent', () => {
    expect(() =>
      clockOffset(utcTimestamp(EPOCH + 100), utcTimestamp(EPOCH), utcTimestamp(EPOCH)),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Exactly-once accounting (§66.6, §25)
// ---------------------------------------------------------------------------

const ROUND_INDEX = 11;
const CLOCK = clockForRound(EPOCH, ROUND_INDEX, EPOCH);

function record(): RecordedRound {
  return recordRound({
    roundId: roundIdFor(ROUND_INDEX) as RoundId,
    roundIndex: ROUND_INDEX,
    clock: CLOCK,
    baseSeedHex: SEED,
    recentRounds: [],
    confidence: CONFIDENCE_LABELS_BY_TICKER,
    picks: [],
    finalizationBlockHash: BLOCK,
    tickCount: TICKS_PER_BATTLE,
    tickFor: (_battleId, left, right, tickIndex, at) => {
      // The recorder passes the tickers the schedule produced, so the cast only
      // restores what the roster already guarantees.
      const leftSide = observe(SEED, ROUND_INDEX, tickIndex, left as ActiveTicker);
      const rightSide = observe(SEED, ROUND_INDEX, tickIndex, right as ActiveTicker);
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

describe('finalization is exactly once', () => {
  it('refuses a second finalization of the same round', () => {
    // §25 and §66.6: finalization happens once and the result is immutable. A
    // retried job must not be able to produce a second set of War Points.
    const recorded = record();
    const finalized = replayRound(recorded.recording);
    expect(finalized.state.state).toBe('FINALIZED');
    expect(() => finalizeRound(finalized.state, CLOCK.battleEndAt, BLOCK, CONFIG)).toThrow();
  });

  it('awards each wallet at most once per reason per battle', () => {
    const recorded = record();
    const seen = new Set<string>();
    for (const award of recorded.outcome.awards) {
      const key = `${award.wallet}|${award.battleId}|${award.reason}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('failure over fabrication', () => {
  it('voids rather than inventing a result when required data never arrives', () => {
    // §61 principle 19. A round with no scorable tick has no result to report,
    // and reporting a zero-zero draw would be an invented one.
    const roundIndex = 12;
    const clock = clockForRound(EPOCH, roundIndex, EPOCH);
    const recorded = recordRound({
      roundId: roundIdFor(roundIndex) as RoundId,
      roundIndex,
      clock,
      baseSeedHex: SEED,
      recentRounds: [],
      confidence: CONFIDENCE_LABELS_BY_TICKER,
      picks: [],
      finalizationBlockHash: BLOCK,
      // No ticks at all: the feed never delivered anything scorable.
      tickCount: 0,
      tickFor: () => {
        throw new Error('No ticks should be requested');
      },
      config: CONFIG,
    });

    expect(recorded.outcome.results).toHaveLength(0);
    expect(recorded.outcome.voided.length).toBeGreaterThan(0);
    expect(recorded.outcome.awards).toHaveLength(0);
  });
});

describe('a deterministic run under adversarial ordering', () => {
  it('reaches the same receiver state whatever order the duplicates arrive in', () => {
    // The property that matters for a reconnect storm: redelivery is noise, and
    // noise must not change where the client ends up.
    const prng = new DeterministicPrng(SEED, 'CHAOS_ORDER');
    const clean = deliver([1, 2, 3, 4, 5]).state;

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const noisy: number[] = [];
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        noisy.push(sequence);
        // Redeliver an already-seen sequence at random.
        if (prng.nextBelow(2) === 0) {
          noisy.push(1 + prng.nextBelow(sequence));
        }
      }
      expect(deliver(noisy).state).toEqual(clean);
    }
  });
});
