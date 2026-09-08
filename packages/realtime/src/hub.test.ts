import { utcTimestamp, walletAddress } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { battleChannel, roundChannel, walletChannel, WORLD_CHANNEL } from './envelope.js';
import {
  channelsOf,
  connect,
  currentSequence,
  disconnect,
  EMPTY_HUB,
  publish,
  subscribe,
  subscriberCount,
  unsubscribe,
  type HubState,
} from './hub.js';

/**
 * Subscription and fan-out.
 *
 * The rule under test throughout is §48.2: a private channel requires proven
 * ownership, and public ones require nothing at all — because §5 makes the
 * whole product watchable without connecting.
 */

const AT = utcTimestamp(1_800_000_000_000);
const ALICE = walletAddress(`0x${'a'.repeat(40)}`);
const BOB = walletAddress(`0x${'b'.repeat(40)}`);

function hubWith(
  ...clients: readonly { id: string; wallet: ReturnType<typeof walletAddress> | null }[]
): HubState {
  return clients.reduce((state, client) => connect(state, client.id, client.wallet), EMPTY_HUB);
}

describe('public channels', () => {
  it('accept a spectator with no wallet', () => {
    // §5: PonsWars is fully watchable without connecting. Requiring a wallet to
    // watch would break the promise the product is built on.
    const hub = hubWith({ id: 'c1', wallet: null });
    const result = subscribe(hub, 'c1', WORLD_CHANNEL);
    expect(result.outcome.kind).toBe('SUBSCRIBED');
  });

  it('accept a spectator on a round and a battle', () => {
    let hub = hubWith({ id: 'c1', wallet: null });
    for (const channel of [roundChannel('r-1'), battleChannel('b-1')]) {
      const result = subscribe(hub, 'c1', channel);
      hub = result.state;
      expect(result.outcome.kind).toBe('SUBSCRIBED');
    }
    expect(channelsOf(hub, 'c1')).toHaveLength(2);
  });
});

describe('private channels', () => {
  it('accept the wallet that owns them', () => {
    const hub = hubWith({ id: 'c1', wallet: ALICE });
    expect(subscribe(hub, 'c1', walletChannel(ALICE)).outcome.kind).toBe('SUBSCRIBED');
  });

  it('refuse another wallet', () => {
    // The whole of §48.2 in one assertion.
    const hub = hubWith({ id: 'c1', wallet: BOB });
    const result = subscribe(hub, 'c1', walletChannel(ALICE));
    expect(result.outcome.kind).toBe('DENIED');
    expect(channelsOf(result.state, 'c1')).toHaveLength(0);
  });

  it('refuse a spectator', () => {
    const hub = hubWith({ id: 'c1', wallet: null });
    expect(subscribe(hub, 'c1', walletChannel(ALICE)).outcome.kind).toBe('DENIED');
  });

  it('deny out loud rather than ignoring', () => {
    // A client that believes it is subscribed and receives nothing cannot tell
    // that from a quiet channel, and waits forever for an event that was never
    // coming.
    const hub = hubWith({ id: 'c1', wallet: BOB });
    const outcome = subscribe(hub, 'c1', walletChannel(ALICE)).outcome;
    expect(outcome.kind === 'DENIED' && outcome.reason.length > 0).toBe(true);
  });

  it('never deliver to a denied subscriber', () => {
    let hub = hubWith({ id: 'c1', wallet: BOB });
    hub = subscribe(hub, 'c1', walletChannel(ALICE)).state;
    const delivery = publish(hub, 'GENESIS_REVEALED', walletChannel(ALICE), AT, {});
    expect(delivery.recipients).toHaveLength(0);
  });
});

describe('fan-out', () => {
  it('reaches every subscriber of that channel and nobody else', () => {
    let hub = hubWith(
      { id: 'c1', wallet: null },
      { id: 'c2', wallet: null },
      { id: 'c3', wallet: null },
    );
    hub = subscribe(hub, 'c1', battleChannel('b-1')).state;
    hub = subscribe(hub, 'c2', battleChannel('b-1')).state;
    hub = subscribe(hub, 'c3', battleChannel('b-2')).state;

    const delivery = publish(hub, 'BATTLE_STATE_UPDATE', battleChannel('b-1'), AT, {});
    expect([...delivery.recipients].sort()).toEqual(['c1', 'c2']);
  });

  it('subscribing twice does not double-deliver', () => {
    let hub = hubWith({ id: 'c1', wallet: null });
    hub = subscribe(hub, 'c1', WORLD_CHANNEL).state;
    const second = subscribe(hub, 'c1', WORLD_CHANNEL);
    expect(second.outcome.kind).toBe('ALREADY_SUBSCRIBED');
    expect(publish(second.state, 'x', WORLD_CHANNEL, AT, {}).recipients).toEqual(['c1']);
  });

  it('stops delivering after an unsubscribe', () => {
    let hub = hubWith({ id: 'c1', wallet: null });
    hub = subscribe(hub, 'c1', WORLD_CHANNEL).state;
    hub = unsubscribe(hub, 'c1', WORLD_CHANNEL);
    expect(publish(hub, 'x', WORLD_CHANNEL, AT, {}).recipients).toHaveLength(0);
  });

  it('stops delivering after a disconnect', () => {
    let hub = hubWith({ id: 'c1', wallet: null });
    hub = subscribe(hub, 'c1', WORLD_CHANNEL).state;
    hub = disconnect(hub, 'c1');
    expect(publish(hub, 'x', WORLD_CHANNEL, AT, {}).recipients).toHaveLength(0);
    expect(subscriberCount(hub, WORLD_CHANNEL)).toBe(0);
  });

  it('refuses a subscription from a connection it does not know', () => {
    expect(subscribe(EMPTY_HUB, 'ghost', WORLD_CHANNEL).outcome.kind).toBe('UNKNOWN_CONNECTION');
  });
});

describe('sequencing', () => {
  it('numbers a channel from zero without skipping', () => {
    let hub = hubWith({ id: 'c1', wallet: null });
    hub = subscribe(hub, 'c1', battleChannel('b-1')).state;

    const seen: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const delivery = publish(hub, 'x', battleChannel('b-1'), AT, {});
      hub = delivery.state;
      seen.push(delivery.envelope.sequence);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('numbers each channel independently', () => {
    // §70.1. A busy battle must not advance the world channel's sequence, or a
    // client watching only the world would see a gap that never happened.
    let hub = EMPTY_HUB;
    for (let index = 0; index < 5; index += 1) {
      hub = publish(hub, 'x', battleChannel('b-1'), AT, {}).state;
    }
    const world = publish(hub, 'x', WORLD_CHANNEL, AT, {});
    expect(world.envelope.sequence).toBe(0);
  });

  it('advances even when nobody is listening', () => {
    // A channel's numbers describe its history, not one client's view of it. A
    // subscriber arriving later must join at a sequence that means the same
    // thing to everyone, which is what makes gap detection work.
    let hub = EMPTY_HUB;
    hub = publish(hub, 'x', WORLD_CHANNEL, AT, {}).state;
    hub = publish(hub, 'x', WORLD_CHANNEL, AT, {}).state;

    hub = connect(hub, 'late', null);
    hub = subscribe(hub, 'late', WORLD_CHANNEL).state;
    expect(publish(hub, 'x', WORLD_CHANNEL, AT, {}).envelope.sequence).toBe(2);
  });

  it('survives the last subscriber leaving', () => {
    // Resetting a sequence because a channel went quiet would make the next
    // subscriber see numbers it had already seen, which §70.7 reads as a replay.
    let hub = hubWith({ id: 'c1', wallet: null });
    hub = subscribe(hub, 'c1', WORLD_CHANNEL).state;
    hub = publish(hub, 'x', WORLD_CHANNEL, AT, {}).state;
    hub = disconnect(hub, 'c1');

    hub = connect(hub, 'c2', null);
    hub = subscribe(hub, 'c2', WORLD_CHANNEL).state;
    expect(publish(hub, 'x', WORLD_CHANNEL, AT, {}).envelope.sequence).toBe(1);
  });

  it('reports the sequence a snapshot should name', () => {
    // §24: a snapshot names where the client is resuming from, which is the
    // last event actually delivered — not the next one, or the client would
    // treat the following event as a duplicate.
    let hub = EMPTY_HUB;
    expect(currentSequence(hub, WORLD_CHANNEL)).toBe(-1);

    hub = publish(hub, 'x', WORLD_CHANNEL, AT, {}).state;
    expect(currentSequence(hub, WORLD_CHANNEL)).toBe(0);

    hub = publish(hub, 'x', WORLD_CHANNEL, AT, {}).state;
    expect(currentSequence(hub, WORLD_CHANNEL)).toBe(1);
  });
});

describe('a reconnect', () => {
  it('resumes where the channel is, not where the old connection was', () => {
    let hub = hubWith({ id: 'old', wallet: ALICE });
    hub = subscribe(hub, 'old', walletChannel(ALICE)).state;
    hub = publish(hub, 'x', walletChannel(ALICE), AT, {}).state;
    hub = publish(hub, 'x', walletChannel(ALICE), AT, {}).state;
    hub = disconnect(hub, 'old');

    hub = connect(hub, 'new', ALICE);
    const resubscribed = subscribe(hub, 'new', walletChannel(ALICE));
    expect(resubscribed.outcome.kind).toBe('SUBSCRIBED');
    expect(currentSequence(resubscribed.state, walletChannel(ALICE))).toBe(1);
  });
});
