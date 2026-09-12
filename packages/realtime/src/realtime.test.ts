import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  battleChannel,
  emit,
  EMPTY_SEQUENCER,
  isChannel,
  maySubscribe,
  PROTOCOL_VERSION,
  roundChannel,
  walletChannel,
  WORLD_CHANNEL,
  type Envelope,
  type SequencerState,
} from './envelope.js';
import {
  applySnapshot,
  clockOffset,
  EMPTY_RECEIVER,
  isAwaitingSnapshot,
  receive,
  serverNow,
  type ReceiverState,
} from './receiver.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (T0 + offset) as UtcTimestamp;
const WALLET = '0x1234567890abcdef1234567890abcdef12345678' as WalletAddress;
const OTHER = '0x000000000000000000000000000000000000dead' as WalletAddress;

const BATTLE = battleChannel('round-0000000001-b0');

const envelope = (sequence: number, channel = BATTLE): Envelope<{ n: number }> => ({
  event: 'BATTLE_STATE_UPDATE',
  version: PROTOCOL_VERSION,
  sequence,
  emittedAt: at(sequence * 1_000),
  channel,
  payload: { n: sequence },
});

const feed = (envelopes: readonly Envelope<{ n: number }>[]): ReceiverState => {
  let state = EMPTY_RECEIVER;
  for (const item of envelopes) {
    state = receive(state, item).state;
  }
  return state;
};

describe('what a channel is', () => {
  it('is the world, a round, a battle or a wallet', () => {
    for (const channel of [
      WORLD_CHANNEL,
      roundChannel('round-0000000412'),
      BATTLE,
      walletChannel(WALLET),
    ]) {
      expect(isChannel(channel), channel).toBe(true);
    }
  });

  it('is nothing a client invents', () => {
    // A server that kept a subscription to any string would keep as many as a
    // client cared to send.
    for (const channel of [
      '',
      'worlds',
      'battle:',
      `battle:${'x'.repeat(97)}`,
      'battle:round 1',
      'admin:everything',
      `wallet:${WALLET.toUpperCase()}`,
      'wallet:0xabc',
    ]) {
      expect(isChannel(channel), channel).toBe(false);
    }
  });
});

describe('channel authorisation', () => {
  it('leaves public channels open', () => {
    // §5: PonsWars stays fully watchable without connecting. Requiring
    // authentication to watch would break the spectator promise.
    for (const channel of [WORLD_CHANNEL, roundChannel('r1'), BATTLE]) {
      expect(maySubscribe(channel, null)).toBe(true);
    }
  });

  it('binds a private channel to its own wallet', () => {
    // §48.2: a private channel requires authenticated session ownership.
    expect(maySubscribe(walletChannel(WALLET), WALLET)).toBe(true);
    expect(maySubscribe(walletChannel(WALLET), OTHER)).toBe(false);
    expect(maySubscribe(walletChannel(WALLET), null)).toBe(false);
  });

  it('does not match a differently-cased address', () => {
    // A mixed-case subscription simply fails to match rather than being
    // accepted, so one address cannot become two subscriptions.
    expect(maySubscribe(`wallet:${WALLET.toUpperCase()}`, WALLET)).toBe(false);
  });
});

describe('server sequencing', () => {
  it('starts at zero and never skips', () => {
    // A gap in what a client receives must mean a lost message, not a server
    // that numbered oddly. That is the entire basis of §70.7 recovery.
    let state: SequencerState = EMPTY_SEQUENCER;
    const sequences: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = emit(state, 'BATTLE_STATE_UPDATE', BATTLE, at(i), { n: i });
      state = result.state;
      sequences.push(result.envelope.sequence);
    }
    expect(sequences).toEqual([0, 1, 2, 3, 4]);
  });

  it('advances channels independently', () => {
    // §48.5: monotonic *within its stream*. A busy battle channel must not push
    // the world channel's numbering forward.
    let state: SequencerState = EMPTY_SEQUENCER;
    state = emit(state, 'A', BATTLE, T0, {}).state;
    state = emit(state, 'A', BATTLE, T0, {}).state;
    const world = emit(state, 'B', WORLD_CHANNEL, T0, {});
    expect(world.envelope.sequence).toBe(0);
  });

  it('stamps the protocol version and channel', () => {
    const { envelope: stamped } = emit(EMPTY_SEQUENCER, 'X', BATTLE, T0, { n: 1 });
    expect(stamped.version).toBe(PROTOCOL_VERSION);
    expect(stamped.channel).toBe(BATTLE);
    expect(stamped.emittedAt).toBe(T0);
  });
});

describe('receiving in order', () => {
  it('applies a contiguous run', () => {
    let state = EMPTY_RECEIVER;
    for (let i = 0; i < 5; i += 1) {
      const result = receive(state, envelope(i));
      expect(result.outcome.kind).toBe('APPLY');
      state = result.state;
    }
    expect(state.lastSequence[BATTLE]).toBe(4);
  });

  it('accepts a first event at any sequence', () => {
    // A client subscribing mid-battle starts from wherever the stream is, not
    // from zero.
    expect(receive(EMPTY_RECEIVER, envelope(4_211)).outcome.kind).toBe('APPLY');
  });

  it('ignores a redelivered event', () => {
    // A reconnect can redeliver. Applying an old update would move the
    // frontline backwards, which reads as the battle reversing.
    const state = feed([envelope(0), envelope(1), envelope(2)]);
    const result = receive(state, envelope(1));
    expect(result.outcome.kind).toBe('DUPLICATE');
    expect(result.state.lastSequence[BATTLE]).toBe(2);
  });
});

describe('gap recovery', () => {
  it('detects a gap and reports how much was missed', () => {
    // §70.7 step 1. A gap of one is a blip; a gap of fifty is an outage, and
    // the difference is worth logging.
    const state = feed([envelope(0), envelope(1)]);
    const result = receive(state, envelope(9));

    expect(result.outcome).toEqual({ kind: 'GAP', expected: 2, received: 9, missing: 7 });
    expect(isAwaitingSnapshot(result.state, BATTLE)).toBe(true);
  });

  it('stops applying incremental updates until the snapshot lands', () => {
    // §70.7: stop applying incremental animation targets. Continuing would
    // animate from a state the client no longer knows.
    let state = feed([envelope(0)]);
    state = receive(state, envelope(5)).state;

    for (const sequence of [6, 7, 8]) {
      const result = receive(state, envelope(sequence));
      expect(result.outcome.kind).toBe('AWAITING_SNAPSHOT');
      state = result.state;
    }
    expect(isAwaitingSnapshot(state, BATTLE)).toBe(true);
  });

  it('resumes from the snapshot rather than rewinding', () => {
    // §24: do not replay every missed animation tick. A client that catches up
    // by replaying ten seconds of frontline movement shows a battle that
    // already happened - it jumps to the truth and animates from there.
    let state = feed([envelope(0)]);
    state = receive(state, envelope(5)).state;
    state = applySnapshot(state, BATTLE, 8);

    expect(isAwaitingSnapshot(state, BATTLE)).toBe(false);
    expect(state.lastSequence[BATTLE]).toBe(8);

    // The events inside the hole are gone for good, and that is correct.
    expect(receive(state, envelope(6)).outcome.kind).toBe('DUPLICATE');
    expect(receive(state, envelope(9)).outcome.kind).toBe('APPLY');
  });

  it('isolates a gap to the channel that had it', () => {
    // One battle losing messages must not stall the world channel.
    let state = feed([envelope(0), envelope(0, WORLD_CHANNEL)]);
    state = receive(state, envelope(5)).state;

    expect(isAwaitingSnapshot(state, BATTLE)).toBe(true);
    expect(isAwaitingSnapshot(state, WORLD_CHANNEL)).toBe(false);
    expect(receive(state, envelope(1, WORLD_CHANNEL)).outcome.kind).toBe('APPLY');
  });

  it('rejects a snapshot sequence that is not a whole number', () => {
    expect(() => applySnapshot(EMPTY_RECEIVER, BATTLE, -1)).toThrow(RangeError);
    expect(() => applySnapshot(EMPTY_RECEIVER, BATTLE, 1.5)).toThrow(RangeError);
  });
});

describe('envelope validation', () => {
  it('rejects an unknown protocol version', () => {
    // Applying half of an envelope a client does not understand is worse than
    // refusing it: §129 gives unsupported environments a clear message rather
    // than a broken scene.
    const result = receive(EMPTY_RECEIVER, { ...envelope(0), version: 99 });
    expect(result.outcome.kind).toBe('REJECTED');
    expect(result.state).toBe(EMPTY_RECEIVER);
  });

  it('rejects a malformed sequence', () => {
    expect(receive(EMPTY_RECEIVER, { ...envelope(0), sequence: -1 }).outcome.kind).toBe('REJECTED');
    expect(receive(EMPTY_RECEIVER, { ...envelope(0), sequence: 1.5 }).outcome.kind).toBe(
      'REJECTED',
    );
  });
});

describe('clock resynchronisation', () => {
  it('computes the offset of a well-behaved exchange', () => {
    // §23.5: server time is authoritative and client timers are a projection.
    // A client whose clock is five minutes fast must still render the same
    // countdown as everyone else.
    const offset = clockOffset(at(0), at(100), at(100));
    expect(offset).toBe(50);
  });

  it('recovers a client running behind the server', () => {
    const skewed = (T0 - 300_000) as UtcTimestamp;
    const offset = clockOffset(skewed, T0, (skewed + 100) as UtcTimestamp);
    expect(serverNow((skewed + 500) as UtcTimestamp, offset)).toBeCloseTo(T0 + 450, -1);
  });

  it('recovers a client running ahead of the server', () => {
    const skewed = (T0 + 300_000) as UtcTimestamp;
    const offset = clockOffset(skewed, T0, (skewed + 100) as UtcTimestamp);
    expect(serverNow((skewed + 500) as UtcTimestamp, offset)).toBeCloseTo(T0 + 450, -1);
  });

  it('rejects a response that predates its request', () => {
    expect(() => clockOffset(at(100), at(100), at(0))).toThrow(RangeError);
  });

  it('projects to a whole millisecond', () => {
    // A fractional timestamp would compare unpredictably against the round
    // boundaries §72 defines.
    expect(Number.isInteger(serverNow(at(0), 0.5))).toBe(true);
  });
});

describe('end to end', () => {
  it('carries a stream through a gap and back', () => {
    let server: SequencerState = EMPTY_SEQUENCER;
    let client = EMPTY_RECEIVER;
    const delivered: number[] = [];

    for (let i = 0; i < 10; i += 1) {
      const { state, envelope: sent } = emit(server, 'BATTLE_STATE_UPDATE', BATTLE, at(i), {
        n: i,
      });
      server = state;

      // The network drops sequences 3 through 5.
      if (sent.sequence >= 3 && sent.sequence <= 5) continue;

      const result = receive(client, sent);
      client = result.state;

      if (result.outcome.kind === 'APPLY') {
        delivered.push(sent.sequence);
      } else if (result.outcome.kind === 'GAP') {
        // §70.7 step 2 and 3: fetch the snapshot, reset the interpolation
        // target. The snapshot reflects the newest state the server holds.
        client = applySnapshot(client, BATTLE, sent.sequence);
        delivered.push(sent.sequence);
      }
    }

    // Everything before the drop, then the snapshot, then the rest — and
    // nothing from inside the hole.
    expect(delivered).toEqual([0, 1, 2, 6, 7, 8, 9]);
    expect(isAwaitingSnapshot(client, BATTLE)).toBe(false);
  });
});
