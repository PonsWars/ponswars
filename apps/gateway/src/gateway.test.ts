import { battleChannel, walletChannel, WORLD_CHANNEL, type Envelope } from '@ponswars/realtime';
import { utcTimestamp, walletAddress } from '@ponswars/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { Gateway } from './gateway.js';
import type { ServerMessage } from './protocol.js';

/**
 * The gateway, driven by frames.
 *
 * Authorisation and sequencing are the hub's and tested there. What is tested
 * here is the binding: that every frame is answered, that a refusal says why,
 * and that an envelope reaches exactly the sockets entitled to it.
 */

const AT = utcTimestamp(1_800_000_000_000);
const ALICE = walletAddress(`0x${'a'.repeat(40)}`);
const BOB = walletAddress(`0x${'b'.repeat(40)}`);

let sent: { connectionId: string; frame: string }[];
let gateway: Gateway;

beforeEach(() => {
  sent = [];
  gateway = new Gateway(
    (connectionId, frame) => sent.push({ connectionId, frame }),
    () => AT,
  );
});

/** Everything one connection received, decoded. */
function received(connectionId: string): unknown[] {
  return sent
    .filter((entry) => entry.connectionId === connectionId)
    .map((entry) => JSON.parse(entry.frame) as unknown);
}

function lastTo(connectionId: string): ServerMessage {
  const all = received(connectionId);
  return all[all.length - 1] as ServerMessage;
}

const frame = (message: unknown): string => JSON.stringify(message);

describe('subscribing', () => {
  it('answers with the sequence the channel stands at', () => {
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));

    expect(lastTo('c1')).toEqual({
      type: 'SUBSCRIBED',
      channel: WORLD_CHANNEL,
      sequence: -1,
    });
  });

  it('reports where a busy channel already is, so a late joiner can detect a gap', () => {
    gateway.open('early', null);
    gateway.receive('early', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
    void gateway.publish('x', WORLD_CHANNEL, AT, {});
    void gateway.publish('x', WORLD_CHANNEL, AT, {});

    gateway.open('late', null);
    gateway.receive('late', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));

    // §24: the snapshot names the last event delivered, so the next one the
    // client sees is expected rather than read as a duplicate.
    expect(lastTo('late')).toMatchObject({ type: 'SUBSCRIBED', sequence: 1 });
  });

  it('answers a repeated subscribe the same way, not with an error', () => {
    // A client that reconnected and is unsure whether it was subscribed needs a
    // usable sequence back, not something it has to interpret.
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));

    expect(lastTo('c1')).toMatchObject({ type: 'SUBSCRIBED' });
  });
});

describe('private channels', () => {
  it('let a wallet watch its own', () => {
    gateway.open('c1', ALICE);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: walletChannel(ALICE) }));
    expect(lastTo('c1')).toMatchObject({ type: 'SUBSCRIBED' });
  });

  it('refuse another wallet, and say why', () => {
    // §48.2. A client told only "error" cannot tell its own bug from a channel
    // it is not entitled to.
    gateway.open('c1', BOB);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: walletChannel(ALICE) }));

    const reply = lastTo('c1');
    expect(reply).toMatchObject({ type: 'ERROR', code: 'FORBIDDEN_CHANNEL' });
    expect(reply.type === 'ERROR' && reply.message.length > 0).toBe(true);
  });

  it('never deliver to a connection that was refused', async () => {
    gateway.open('c1', BOB);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: walletChannel(ALICE) }));
    sent = [];

    await gateway.publish('GENESIS_REVEALED', walletChannel(ALICE), AT, { rarity: 'SECRET' });
    expect(received('c1')).toHaveLength(0);
  });
});

describe('fan-out', () => {
  it('reaches every subscriber and nobody else', async () => {
    gateway.open('c1', null);
    gateway.open('c2', null);
    gateway.open('c3', null);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: battleChannel('b-1') }));
    gateway.receive('c2', frame({ type: 'SUBSCRIBE', channel: battleChannel('b-1') }));
    gateway.receive('c3', frame({ type: 'SUBSCRIBE', channel: battleChannel('b-2') }));
    sent = [];

    await gateway.publish('BATTLE_STATE_UPDATE', battleChannel('b-1'), AT, { momentum: 'PUSHING' });

    expect(received('c1')).toHaveLength(1);
    expect(received('c2')).toHaveLength(1);
    expect(received('c3')).toHaveLength(0);
  });

  it('sends a well-formed envelope', async () => {
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: battleChannel('b-1') }));
    sent = [];

    await gateway.publish('BATTLE_STATE_UPDATE', battleChannel('b-1'), AT, { momentum: 'SURGING' });

    const envelope = received('c1')[0] as Envelope<{ momentum: string }>;
    expect(envelope).toMatchObject({
      event: 'BATTLE_STATE_UPDATE',
      channel: battleChannel('b-1'),
      sequence: 0,
      emittedAt: AT,
      payload: { momentum: 'SURGING' },
    });
  });

  it('stops after an unsubscribe, and confirms it', async () => {
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
    gateway.receive('c1', frame({ type: 'UNSUBSCRIBE', channel: WORLD_CHANNEL }));
    expect(lastTo('c1')).toEqual({ type: 'UNSUBSCRIBED', channel: WORLD_CHANNEL });

    sent = [];
    await gateway.publish('x', WORLD_CHANNEL, AT, {});
    expect(received('c1')).toHaveLength(0);
  });

  it('stops after a close', async () => {
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
    gateway.close('c1');
    sent = [];

    await gateway.publish('x', WORLD_CHANNEL, AT, {});
    expect(sent).toHaveLength(0);
  });

  it('publishes to nobody without failing', async () => {
    // A round ticks whether or not anyone is watching, and the sequence still
    // has to advance.
    await expect(gateway.publish('x', WORLD_CHANNEL, AT, {})).resolves.toBeUndefined();
  });
});

describe('malformed frames', () => {
  it('are answered rather than dropped', () => {
    // A frame the server silently ignores leaves the client believing something
    // happened, and the failure surfaces much later as an event that never
    // arrives.
    gateway.open('c1', null);
    for (const bad of ['not json', '{}', '{"type":"NOPE"}', '{"type":"SUBSCRIBE"}']) {
      sent = [];
      gateway.receive('c1', bad);
      expect(lastTo('c1')).toMatchObject({ type: 'ERROR', code: 'BAD_FRAME' });
    }
  });

  it('do not subscribe anything', async () => {
    gateway.open('c1', null);
    gateway.receive('c1', '{"type":"SUBSCRIBE"}');
    sent = [];
    await gateway.publish('x', WORLD_CHANNEL, AT, {});
    expect(received('c1')).toHaveLength(0);
  });
});

describe('liveness', () => {
  it('echoes the client timestamp beside server time', () => {
    // §23.5: the client measures its offset rather than trusting its own clock.
    // Echoing `sentAt` lets it compute the round trip without keeping state.
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'PING', sentAt: 1_234 }));

    expect(lastTo('c1')).toEqual({ type: 'PONG', sentAt: 1_234, serverTime: AT });
  });

  it('refuses a ping with no usable timestamp', () => {
    gateway.open('c1', null);
    gateway.receive('c1', frame({ type: 'PING', sentAt: 'soon' }));
    expect(lastTo('c1')).toMatchObject({ type: 'ERROR' });
  });
});
