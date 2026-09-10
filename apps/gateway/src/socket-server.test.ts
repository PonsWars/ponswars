import { battleChannel, walletChannel, WORLD_CHANNEL } from '@ponswars/realtime';
import { utcTimestamp, walletAddress } from '@ponswars/shared-types';
import type { AddressInfo } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFrame, startSocketServer, type RunningSocketServer } from './socket-server.js';

/**
 * The socket binding, over a real socket.
 *
 * Everything above this file is tested without one, which is the point of the
 * split. What has to be checked here is only what a real connection adds:
 * frames actually arrive, a closed socket stops receiving, and an authorised
 * client gets its private channel while an unauthorised one does not — end to
 * end, over TCP.
 */

const AT = utcTimestamp(1_800_000_000_000);
const ALICE = walletAddress(`0x${'a'.repeat(40)}`);
const BOB = walletAddress(`0x${'b'.repeat(40)}`);

let running: RunningSocketServer | null = null;
const opened: WebSocket[] = [];

afterEach(async () => {
  for (const socket of opened) {
    socket.close();
  }
  opened.length = 0;
  await running?.close();
  running = null;
});

/** Starts a server on an ephemeral port and returns its URL. */
function start(walletFor: (auth: string | undefined) => ReturnType<typeof walletAddress> | null) {
  running = startSocketServer({
    port: 0,
    now: () => AT,
    walletOf: (auth) => Promise.resolve(walletFor(auth)),
  });
  const address = running.wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${String(address.port)}`, server: running };
}

/** Opens a client and resolves once it is connected. */
async function client(url: string, authorization?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
  opened.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** The next frame that client receives, decoded. */
function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('No frame arrived within a second.'));
    }, 1_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(decodeFrame(data)) as Record<string, unknown>);
    });
  });
}

describe('a real connection', () => {
  it('subscribes and is told where the channel stands', async () => {
    const { url } = start(() => null);
    const socket = await client(url);

    socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
    expect(await nextFrame(socket)).toMatchObject({
      type: 'SUBSCRIBED',
      channel: WORLD_CHANNEL,
    });
  });

  it('receives a published envelope', async () => {
    const { url, server } = start(() => null);
    const socket = await client(url);

    socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: battleChannel('b-1') }));
    await nextFrame(socket);

    const arriving = nextFrame(socket);
    await server.gateway.publish('BATTLE_STATE_UPDATE', battleChannel('b-1'), AT, {
      momentum: 'SURGING',
    });

    expect(await arriving).toMatchObject({
      event: 'BATTLE_STATE_UPDATE',
      sequence: 0,
      payload: { momentum: 'SURGING' },
    });
  });

  it('delivers to two clients and not to a third', async () => {
    const { url, server } = start(() => null);
    const [watching, alsoWatching, elsewhere] = await Promise.all([
      client(url),
      client(url),
      client(url),
    ]);

    for (const socket of [watching, alsoWatching]) {
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: battleChannel('b-1') }));
      await nextFrame(socket);
    }
    elsewhere.send(JSON.stringify({ type: 'SUBSCRIBE', channel: battleChannel('b-2') }));
    await nextFrame(elsewhere);

    const both = Promise.all([nextFrame(watching), nextFrame(alsoWatching)]);
    let elsewhereReceived = false;
    elsewhere.once('message', () => {
      elsewhereReceived = true;
    });

    await server.gateway.publish('BATTLE_STATE_UPDATE', battleChannel('b-1'), AT, {});
    const received = await both;

    expect(received).toHaveLength(2);
    expect(elsewhereReceived).toBe(false);
  });
});

describe('authorisation over the wire', () => {
  it('gives a wallet its own channel', async () => {
    const { url } = start((auth) => (auth === 'alice' ? ALICE : null));
    const socket = await client(url, 'alice');

    socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: walletChannel(ALICE) }));
    expect(await nextFrame(socket)).toMatchObject({ type: 'SUBSCRIBED' });
  });

  it('refuses another wallet’s channel, over a real socket', async () => {
    // §48.2, end to end. The hub decides it; this proves the decision survives
    // the trip through the socket layer.
    const { url } = start((auth) => (auth === 'bob' ? BOB : null));
    const socket = await client(url, 'bob');

    socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: walletChannel(ALICE) }));
    expect(await nextFrame(socket)).toMatchObject({
      type: 'ERROR',
      code: 'FORBIDDEN_CHANNEL',
    });
  });

  it('lets an anonymous client watch the world', async () => {
    // §5: watching needs no wallet. A connection with no authorization header
    // is the ordinary case.
    const { url } = start(() => null);
    const socket = await client(url);

    socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
    expect(await nextFrame(socket)).toMatchObject({ type: 'SUBSCRIBED' });
  });
});

describe('a closed socket', () => {
  it('stops being sent to, and does not break the fan-out', async () => {
    const { url, server } = start(() => null);
    const staying = await client(url);
    const leaving = await client(url);

    for (const socket of [staying, leaving]) {
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: WORLD_CHANNEL }));
      await nextFrame(socket);
    }

    leaving.close();
    // Wait for the server to observe the close rather than assuming it has.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const arriving = nextFrame(staying);
    await server.gateway.publish('x', WORLD_CHANNEL, AT, {});
    expect(await arriving).toMatchObject({ event: 'x' });
  });
});

describe('liveness over the wire', () => {
  it('answers a ping with server time', async () => {
    const { url } = start(() => null);
    const socket = await client(url);

    socket.send(JSON.stringify({ type: 'PING', sentAt: 42 }));
    expect(await nextFrame(socket)).toEqual({ type: 'PONG', sentAt: 42, serverTime: AT });
  });

  it('answers a malformed frame instead of dropping the connection', async () => {
    const { url } = start(() => null);
    const socket = await client(url);

    socket.send('not json at all');
    expect(await nextFrame(socket)).toMatchObject({ type: 'ERROR', code: 'BAD_FRAME' });
    expect(socket.readyState).toBe(socket.OPEN);
  });
});

describe('starting up', () => {
  it('reports a taken port instead of taking the process down', async () => {
    // The bug: `ws` announces a failed bind by emitting `error` on the server,
    // and with no listener that is an unhandled event — the process dies with a
    // stack trace, a tick after the call that caused it, by which time whatever
    // started next has bound its own port too. A caller that can await the
    // failure can stop before that happens.
    const { server } = start(() => null);
    const port = (server.wss.address() as AddressInfo).port;

    const second = startSocketServer({
      port,
      now: () => AT,
      walletOf: () => Promise.resolve(null),
    });
    await expect(second.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.close();
  });

  it('resolves once it is actually accepting connections', async () => {
    const { url, server } = start(() => null);
    await expect(server.ready).resolves.toBeUndefined();

    // Ready means ready: a client may connect the moment it settles.
    const socket = await client(url);
    expect(socket.readyState).toBe(socket.OPEN);
  });
});

describe('a session that takes a moment to resolve', () => {
  /** A server whose wallet lookup answers only after `release()` is called. */
  function slowStart(wallet: ReturnType<typeof walletAddress> | null) {
    let release = (): void => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    running = startSocketServer({
      port: 0,
      now: () => AT,
      walletOf: async () => {
        await answered;
        return wallet;
      },
    });
    const address = running.wss.address() as AddressInfo;
    return { url: `ws://127.0.0.1:${String(address.port)}`, release };
  }

  it('answers the first frame with the wallet, not without it', async () => {
    // Resolving a session is a database read (§45.2). A frame that arrived
    // before the answer used to reach a gateway that had not opened the
    // connection yet — so a player's own channel was refused as a spectator's.
    // The connection is paused until the lookup returns, which makes the delay
    // invisible rather than wrong.
    const { url, release } = slowStart(ALICE);
    const socket = await client(url, 'Bearer alice');
    const answer = nextFrame(socket);

    socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel: `wallet:${ALICE}` }));
    // Long enough that the frame has certainly reached the server and would
    // have been read had the socket not been paused. Without the pause this
    // test fails here rather than passing by a scheduling accident.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    expect(await answer).toMatchObject({
      type: 'SUBSCRIBED',
      channel: `wallet:${ALICE}`,
    });
  });

  it('closes rather than downgrading a player to a spectator', async () => {
    // The session store being unreachable is not a spectator. Carrying on as
    // one would silently take a player's own channel away mid-round.
    running = startSocketServer({
      port: 0,
      now: () => AT,
      walletOf: () => Promise.reject(new Error('session store unreachable')),
    });
    const address = running.wss.address() as AddressInfo;
    const socket = await client(`ws://127.0.0.1:${String(address.port)}`, 'Bearer alice');

    const code = await new Promise<number>((resolve) => {
      socket.once('close', resolve);
    });

    expect(code).toBe(1011);
  });
});

describe('decoding a frame', () => {
  it('reads a single buffer', () => {
    expect(decodeFrame(Buffer.from('{"type":"PING"}', 'utf8'))).toBe('{"type":"PING"}');
  });

  it('reassembles a fragmented message', () => {
    // The bug this exists for: `ws` hands a fragmented message back as an array
    // of buffers, and `toString()` on that array yields `[object Object]` —
    // valid JavaScript, silently wrong, and only ever seen on messages large
    // enough to be split. Every small test would have passed.
    const fragments: RawData = [Buffer.from('{"type":', 'utf8'), Buffer.from('"PING"}', 'utf8')];
    expect(decodeFrame(fragments)).toBe('{"type":"PING"}');
  });

  it('reads an ArrayBuffer', () => {
    const bytes = new TextEncoder().encode('{"type":"PING"}');
    expect(decodeFrame(bytes.buffer)).toBe('{"type":"PING"}');
  });

  it('handles multi-byte characters split across fragments', () => {
    // A fragment boundary can fall inside a UTF-8 sequence. Decoding each
    // buffer separately would produce replacement characters; concatenating
    // first is what makes it correct.
    const full = Buffer.from('{"m":"€"}', 'utf8');
    const fragments: RawData = [full.subarray(0, 6), full.subarray(6)];
    expect(decodeFrame(fragments)).toBe('{"m":"€"}');
  });
});
