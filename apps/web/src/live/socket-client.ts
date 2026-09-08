import {
  EMPTY_RECEIVER,
  receive,
  WORLD_CHANNEL,
  battleChannel,
  roundChannel,
  type Channel,
  type Envelope,
  type ReceiverState,
} from '@ponswars/realtime';
import type { LiveEndpoints } from './endpoints.js';

/**
 * The client end of the realtime stream (§48, §70.7).
 *
 * The decisions all live in `@ponswars/realtime`'s receiver, which is a pure
 * reducer: it decides whether an envelope is in order, a duplicate, or a gap,
 * and it runs the same way in a browser, a test and a replay tool. This file
 * owns a socket, a timer and a backoff counter, and defers every judgement to
 * that reducer.
 *
 * Written this way for the reason §70.7 exists. The rule on a gap is *"do not
 * replay every missed animation tick"* — jump to the truth and animate from
 * there — and a rule like that is worth having in one tested place rather than
 * spread across a socket handler.
 */

/** What the socket asks the application to do. */
export interface LiveSocketHandlers {
  /** An in-order event on a channel. Apply it. */
  readonly onEvent: (event: string, channel: Channel, payload: unknown, at: number) => void;
  /**
   * A gap was detected, or the connection came back.
   *
   * Both mean the same thing to the application: what it holds may be stale, so
   * fetch the authoritative snapshot (§70.7 step 2). One function rather than
   * two, because treating a reconnect differently from a gap is how a client
   * ends up trusting state it kept across an outage.
   */
  readonly onResync: (reason: string) => void;
  readonly onConnectionChange: (state: 'CONNECTED' | 'RECONNECTING' | 'OFFLINE') => void;
}

export interface LiveSocketOptions {
  readonly endpoints: LiveEndpoints;
  readonly handlers: LiveSocketHandlers;
  /**
   * Delays between reconnect attempts, in milliseconds.
   *
   * A list rather than a formula: the shape of a backoff is a product decision
   * about how long a player stares at a paused world, and a list can be read
   * and changed without deriving anything.
   */
  readonly backoffMs?: readonly number[];
  /** Injected so tests do not need a network. */
  readonly socketFactory?: (url: string) => WebSocketLike;
}

/** The part of `WebSocket` this uses, so a test can supply a fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const DEFAULT_BACKOFF = [500, 1_000, 2_000, 5_000, 10_000] as const;

export interface LiveSocket {
  /**
   * Follows a round and its five battles, replacing whatever was followed.
   *
   * The battles are named separately because §48.1 gives each one its own
   * channel: `BATTLE_STATE_UPDATE` never travels on the round's channel, so a
   * client subscribed only to the round would watch a frontline that never
   * moves and have no way to tell that from a quiet market.
   */
  follow: (roundId: string, battleIds: readonly string[]) => void;
  close: () => void;
}

/**
 * Opens the stream and keeps it open.
 *
 * Returns immediately; everything after that arrives through the handlers.
 */
export function openLiveSocket(options: LiveSocketOptions): LiveSocket {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF;
  const factory = options.socketFactory ?? ((url: string) => new WebSocket(url) as WebSocketLike);

  let socket: WebSocketLike | null = null;
  let receiver: ReceiverState = EMPTY_RECEIVER;
  let followed: readonly Channel[] = [];
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const subscribe = (channel: Channel): void => {
    socket?.send(JSON.stringify({ type: 'SUBSCRIBE', channel }));
  };

  const connect = (): void => {
    if (closed) {
      return;
    }
    const next = factory(options.endpoints.socket);
    socket = next;

    next.onopen = () => {
      attempt = 0;
      // The receiver starts over on a new connection. Sequences are per
      // connection on the server's side of the fan-out, and carrying the old
      // channel positions across would read the first frame as a duplicate.
      receiver = EMPTY_RECEIVER;
      options.handlers.onConnectionChange('CONNECTED');
      subscribe(WORLD_CHANNEL);
      for (const channel of followed) {
        subscribe(channel);
      }
      // §49 resubscribes and replays a snapshot. Even a clean reconnect means
      // time passed unobserved, so what the client holds is a guess until the
      // snapshot lands.
      options.handlers.onResync('connected');
    };

    next.onmessage = (event) => {
      handleFrame(event.data);
    };

    next.onerror = () => {
      // Reported through `onclose`, which always follows. Acting here as well
      // would count one failure twice and skip a backoff step.
    };

    next.onclose = () => {
      socket = null;
      if (closed) {
        return;
      }
      // §42.14 and §110.5: say which. `RECONNECTING` promises the world will
      // come back; `OFFLINE` admits the display is out of date, and a client
      // that keeps promising through a long outage is lying.
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 10_000;
      options.handlers.onConnectionChange(attempt === 0 ? 'RECONNECTING' : 'OFFLINE');
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };
  };

  const handleFrame = (data: unknown): void => {
    if (typeof data !== 'string') {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isEnvelope(frame)) {
      // Control frames — SUBSCRIBED, PONG, ERROR — are not sequenced events and
      // are not the receiver's business.
      return;
    }

    const result = receive(receiver, frame);
    receiver = result.state;

    switch (result.outcome.kind) {
      case 'APPLY':
        options.handlers.onEvent(frame.event, frame.channel, frame.payload, frame.emittedAt);
        return;
      case 'GAP':
        options.handlers.onResync(`gap of ${String(result.outcome.missing)} on ${frame.channel}`);
        return;
      case 'DUPLICATE':
      case 'AWAITING_SNAPSHOT':
      case 'REJECTED':
        // Nothing to apply and nothing to fetch. A duplicate is ordinary after
        // a reconnect, and a channel already waiting for a snapshot has a
        // request in flight — asking again would make an outage into a storm.
        return;
    }
  };

  connect();

  return {
    follow: (roundId: string, battleIds: readonly string[]) => {
      const channels = [roundChannel(roundId), ...battleIds.map(battleChannel)];
      if (channels.length === followed.length && channels.every((c, i) => c === followed[i])) {
        return;
      }
      followed = channels;
      for (const channel of channels) {
        subscribe(channel);
      }
    },
    close: () => {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      socket?.close();
      socket = null;
    },
  };
}

/**
 * Whether a decoded frame is a sequenced envelope.
 *
 * Checked structurally rather than by trusting a `type` field, because the
 * receiver's guarantees rest on `sequence` and `version` actually being there.
 */
function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const frame = value as Partial<Envelope<unknown>>;
  return (
    typeof frame.event === 'string' &&
    typeof frame.channel === 'string' &&
    typeof frame.sequence === 'number' &&
    typeof frame.version === 'number' &&
    typeof frame.emittedAt === 'number'
  );
}
