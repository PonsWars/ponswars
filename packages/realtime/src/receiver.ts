import type { UtcTimestamp } from '@ponswars/shared-types';
import { PROTOCOL_VERSION, type Channel, type Envelope } from './envelope.js';

/**
 * Client-side receive logic (§70.7, §24).
 *
 * §70.7 spells out what happens on a gap:
 *
 * > 1. stop applying incremental animation targets,
 * > 2. fetch authoritative snapshot,
 * > 3. reset local interpolation target,
 *
 * and §24 adds the rule that makes it correct: *"Do not replay every missed
 * animation tick."* A client that catches up by replaying ten seconds of
 * frontline movement shows a battle that already happened. It jumps to the
 * truth and animates from there.
 *
 * Implemented as a reducer so the same logic runs in a browser, in a test, and
 * in a replay tool without any of them needing a socket.
 */

/** Last sequence seen per channel, plus whether that channel is currently sane. */
export interface ReceiverState {
  readonly lastSequence: Readonly<Record<Channel, number>>;
  /** Channels waiting for a snapshot after a gap. */
  readonly awaitingSnapshot: readonly Channel[];
}

export const EMPTY_RECEIVER: ReceiverState = { lastSequence: {}, awaitingSnapshot: [] };

export type ReceiveOutcome =
  /** In order and applicable. */
  | { readonly kind: 'APPLY' }
  /**
   * Already seen. A reconnect can redeliver, and applying an old update would
   * move the frontline backwards.
   */
  | { readonly kind: 'DUPLICATE'; readonly seen: number }
  /**
   * A gap. §70.7: stop applying incremental targets and fetch a snapshot.
   * `missing` is how many events were lost, which is worth logging — a gap of
   * one is a blip, a gap of fifty is an outage.
   */
  | {
      readonly kind: 'GAP';
      readonly expected: number;
      readonly received: number;
      readonly missing: number;
    }
  /** The channel is already waiting for a snapshot; nothing incremental applies. */
  | { readonly kind: 'AWAITING_SNAPSHOT' }
  /** Unusable envelope. Never applied, never guessed at. */
  | { readonly kind: 'REJECTED'; readonly reason: string };

/**
 * Processes one received envelope.
 *
 * Pure: state and envelope in, new state and an instruction out. The caller
 * decides what to do with `APPLY` or `GAP`; this decides only what is true.
 */
export function receive<TPayload>(
  state: ReceiverState,
  envelope: Envelope<TPayload>,
): { readonly state: ReceiverState; readonly outcome: ReceiveOutcome } {
  if (envelope.version !== PROTOCOL_VERSION) {
    // A version the client does not understand is not something to apply
    // partially. §129 gives unsupported environments a clear message rather
    // than a broken scene, and the same principle holds here.
    return {
      state,
      outcome: {
        kind: 'REJECTED',
        reason: `unsupported protocol version ${String(envelope.version)}`,
      },
    };
  }
  if (!Number.isInteger(envelope.sequence) || envelope.sequence < 0) {
    return {
      state,
      outcome: { kind: 'REJECTED', reason: 'sequence must be a non-negative integer' },
    };
  }

  if (state.awaitingSnapshot.includes(envelope.channel)) {
    // §70.7 step 1: incremental targets stop until the snapshot lands. Tracking
    // the sequence meanwhile would let a second gap go unnoticed.
    return { state, outcome: { kind: 'AWAITING_SNAPSHOT' } };
  }

  const last = state.lastSequence[envelope.channel];
  const expected = last === undefined ? envelope.sequence : last + 1;

  if (last !== undefined && envelope.sequence <= last) {
    // A reconnect can redeliver. Applying an old update would move the
    // frontline backwards, which reads as the battle reversing.
    return { state, outcome: { kind: 'DUPLICATE', seen: last } };
  }

  if (envelope.sequence !== expected) {
    return {
      state: {
        lastSequence: state.lastSequence,
        awaitingSnapshot: [...state.awaitingSnapshot, envelope.channel],
      },
      outcome: {
        kind: 'GAP',
        expected,
        received: envelope.sequence,
        missing: envelope.sequence - expected,
      },
    };
  }

  return {
    state: {
      lastSequence: { ...state.lastSequence, [envelope.channel]: envelope.sequence },
      awaitingSnapshot: state.awaitingSnapshot,
    },
    outcome: { kind: 'APPLY' },
  };
}

/**
 * Applies a snapshot, clearing the gap.
 *
 * §24 reconnect flow: fetch the authoritative snapshot, resync canonical time,
 * then *"jump/animate smoothly toward current frontline"*. The client resumes
 * from the snapshot's sequence — it does not rewind to fill the hole, because
 * the events in it describe a battle state that has already been superseded.
 */
export function applySnapshot(
  state: ReceiverState,
  channel: Channel,
  snapshotSequence: number,
): ReceiverState {
  if (!Number.isInteger(snapshotSequence) || snapshotSequence < 0) {
    throw new RangeError('Snapshot sequence must be a non-negative integer');
  }
  return {
    lastSequence: { ...state.lastSequence, [channel]: snapshotSequence },
    awaitingSnapshot: state.awaitingSnapshot.filter((waiting) => waiting !== channel),
  };
}

/** Channels currently blocked on a snapshot. */
export function isAwaitingSnapshot(state: ReceiverState, channel: Channel): boolean {
  return state.awaitingSnapshot.includes(channel);
}

// ---------------------------------------------------------------------------
// Clock resynchronisation (§23.5, §24)
// ---------------------------------------------------------------------------

/**
 * The offset between server and local clocks.
 *
 * §23.5 makes server time authoritative and client timers a projection. A
 * client with a clock five minutes fast must still render the same countdown as
 * everyone else, so it tracks the offset rather than trusting itself.
 *
 * Measured the way NTP does: half the round trip is assumed to be the one-way
 * delay. It is an assumption, but a wrong one shifts a countdown by
 * milliseconds — and §72.4 already makes the server, not the countdown, decide
 * whether a pick was in time.
 */
export function clockOffset(
  requestSentAt: UtcTimestamp,
  serverTime: UtcTimestamp,
  responseReceivedAt: UtcTimestamp,
): number {
  if (responseReceivedAt < requestSentAt) {
    throw new RangeError('The response cannot have arrived before the request was sent');
  }
  const roundTrip = responseReceivedAt - requestSentAt;
  return serverTime + roundTrip / 2 - responseReceivedAt;
}

/** Projects local time onto the server clock. */
export function serverNow(localNow: UtcTimestamp, offset: number): UtcTimestamp {
  return Math.round(localNow + offset) as UtcTimestamp;
}
