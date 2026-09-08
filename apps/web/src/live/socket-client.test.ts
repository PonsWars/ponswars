import { PROTOCOL_VERSION, WORLD_CHANNEL } from '@ponswars/realtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLiveSocket, type LiveSocket, type WebSocketLike } from './socket-client.js';

/**
 * The socket layer, without a socket.
 *
 * Everything worth asserting here is about *when* the client asks for a
 * snapshot, and that is exactly what a network makes hard to test. The fake
 * below is a script: it records what was sent, and the test decides when a
 * frame arrives and when the connection drops.
 */

const ENDPOINTS = { api: 'https://api.test', socket: 'wss://ws.test' };

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** What the client subscribed to, in order. */
  get subscriptions(): string[] {
    return this.sent
      .map((frame) => JSON.parse(frame) as { type: string; channel?: string })
      .filter((frame) => frame.type === 'SUBSCRIBE')
      .map((frame) => frame.channel ?? '');
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const envelope = (sequence: number, channel = 'battle:b-1'): Record<string, unknown> => ({
  event: 'BATTLE_STATE_UPDATE',
  version: PROTOCOL_VERSION,
  sequence,
  emittedAt: 1_800_000_000_000,
  channel,
  payload: { momentum: 'SURGING' },
});

interface Harness {
  readonly sockets: FakeSocket[];
  readonly events: { event: string; channel: string }[];
  readonly resyncs: string[];
  readonly connections: string[];
  readonly live: LiveSocket;
}

function harness(): Harness {
  const sockets: FakeSocket[] = [];
  const events: { event: string; channel: string }[] = [];
  const resyncs: string[] = [];
  const connections: string[] = [];

  const live = openLiveSocket({
    endpoints: ENDPOINTS,
    backoffMs: [10, 20],
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    handlers: {
      onEvent: (event, channel) => events.push({ event, channel }),
      onResync: (reason) => resyncs.push(reason),
      onConnectionChange: (state) => connections.push(state),
    },
  });

  return { sockets, events, resyncs, connections, live };
}

/** The most recently created fake socket, opened. */
function open(h: Harness): FakeSocket {
  const socket = h.sockets[h.sockets.length - 1];
  if (socket === undefined) throw new Error('no socket was created');
  socket.onopen?.({});
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connecting', () => {
  it('subscribes to the world and asks for a snapshot', () => {
    // §49 resubscribes and replays a snapshot. Even a first connection means
    // the client holds nothing yet, so it asks before it renders.
    const h = harness();
    const socket = open(h);

    expect(socket.subscriptions).toEqual([WORLD_CHANNEL]);
    expect(h.resyncs).toEqual(['connected']);
    expect(h.connections).toEqual(['CONNECTED']);
    h.live.close();
  });

  it('follows a round and each of its battles', () => {
    // §48.1 gives every battle its own channel, and BATTLE_STATE_UPDATE never
    // travels on the round's — a client subscribed only to the round would
    // watch a frontline that never moves.
    const h = harness();
    const socket = open(h);
    h.live.follow('round-1', ['b-1', 'b-2']);

    expect(socket.subscriptions).toEqual([
      WORLD_CHANNEL,
      'round:round-1',
      'battle:b-1',
      'battle:b-2',
    ]);
    h.live.close();
  });

  it('does not resubscribe to the same round twice', () => {
    const h = harness();
    const socket = open(h);
    h.live.follow('round-1', ['b-1']);
    h.live.follow('round-1', ['b-1']);

    expect(socket.subscriptions).toHaveLength(3);
    h.live.close();
  });
});

describe('receiving', () => {
  it('applies frames in order', () => {
    const h = harness();
    const socket = open(h);
    socket.deliver(envelope(0));
    socket.deliver(envelope(1));

    expect(h.events).toEqual([
      { event: 'BATTLE_STATE_UPDATE', channel: 'battle:b-1' },
      { event: 'BATTLE_STATE_UPDATE', channel: 'battle:b-1' },
    ]);
    h.live.close();
  });

  it('asks for a snapshot on a gap instead of applying across it', () => {
    // §70.7: stop applying incremental targets and fetch. §24 adds the rule
    // that makes it right — do not replay every missed tick, because a client
    // that catches up shows a battle that already happened.
    const h = harness();
    const socket = open(h);
    socket.deliver(envelope(0));
    socket.deliver(envelope(5));

    expect(h.events).toHaveLength(1);
    expect(h.resyncs).toEqual(['connected', 'gap of 4 on battle:b-1']);
    h.live.close();
  });

  it('ignores a duplicate rather than moving the frontline backwards', () => {
    const h = harness();
    const socket = open(h);
    socket.deliver(envelope(0));
    socket.deliver(envelope(1));
    socket.deliver(envelope(1));

    expect(h.events).toHaveLength(2);
    h.live.close();
  });

  it('ignores control frames and rubbish without dropping the connection', () => {
    const h = harness();
    const socket = open(h);
    socket.deliver({ type: 'SUBSCRIBED', channel: WORLD_CHANNEL });
    socket.deliver({ type: 'PONG', sentAt: 1, serverTime: 2 });
    socket.onmessage?.({ data: 'not json' });
    socket.onmessage?.({ data: 42 });

    expect(h.events).toHaveLength(0);
    expect(h.resyncs).toEqual(['connected']);
    h.live.close();
  });

  it('refuses a protocol version it does not understand', () => {
    const h = harness();
    const socket = open(h);
    socket.deliver({ ...envelope(0), version: PROTOCOL_VERSION + 1 });

    expect(h.events).toHaveLength(0);
    h.live.close();
  });
});

describe('losing the connection', () => {
  it('reconnects, resubscribes to what it was following, and resyncs', () => {
    const h = harness();
    const first = open(h);
    h.live.follow('round-1', ['b-1']);

    first.onclose?.({});
    vi.advanceTimersByTime(10);
    const second = open(h);

    expect(h.sockets).toHaveLength(2);
    expect(second.subscriptions).toEqual([WORLD_CHANNEL, 'round:round-1', 'battle:b-1']);
    expect(h.connections).toEqual(['CONNECTED', 'RECONNECTING', 'CONNECTED']);
    expect(h.resyncs).toEqual(['connected', 'connected']);
    h.live.close();
  });

  it('admits it is offline once reconnecting has failed', () => {
    // §42.14 and §110.5. `RECONNECTING` promises the world is coming back;
    // repeating that promise through a long outage would be a lie, and a
    // frozen HUD that still looks live is worse than one that admits it.
    const h = harness();
    open(h).onclose?.({});
    vi.advanceTimersByTime(10);
    h.sockets[1]?.onclose?.({});

    expect(h.connections).toEqual(['CONNECTED', 'RECONNECTING', 'OFFLINE']);
    h.live.close();
  });

  it('stops reconnecting once closed', () => {
    const h = harness();
    const socket = open(h);
    h.live.close();
    socket.onclose?.({});
    vi.advanceTimersByTime(1_000);

    expect(h.sockets).toHaveLength(1);
  });
});
