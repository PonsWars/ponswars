import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';
import {
  emit,
  EMPTY_SEQUENCER,
  maySubscribe,
  type Channel,
  type Envelope,
  type SequencerState,
} from './envelope.js';

/**
 * Who is listening to what, and who is allowed to (§48.1, §48.2, §70.1).
 *
 * A reducer, like everything else that decides something. The socket library is
 * a binding over this: it turns a message into a call and an envelope into a
 * frame, and knows nothing about authorisation or sequencing.
 *
 * That split is what makes the rule in §48.2 testable. *"A private channel
 * requires authenticated session ownership of that wallet address"* is one
 * comparison, and it either happens for every subscription or it does not — a
 * property far easier to assert against a function than against a live socket.
 */

/** One connected client. */
interface ConnectionState {
  readonly wallet: WalletAddress | null;
  readonly channels: readonly Channel[];
}

export interface HubState {
  readonly connections: Readonly<Record<string, ConnectionState>>;
  /** Per-channel sequence, shared across every subscriber (§70.1). */
  readonly sequencer: SequencerState;
}

export const EMPTY_HUB: HubState = { connections: {}, sequencer: EMPTY_SEQUENCER };

/**
 * Registers a connection.
 *
 * `wallet` is `null` for a spectator, which is the common case: §5 keeps
 * PonsWars fully watchable without connecting, so an anonymous socket is normal
 * rather than a degraded state.
 */
export function connect(
  state: HubState,
  connectionId: string,
  wallet: WalletAddress | null,
): HubState {
  return {
    ...state,
    connections: { ...state.connections, [connectionId]: { wallet, channels: [] } },
  };
}

/**
 * Attaches a proven wallet to a connection that is already open (§48.2, §45.2).
 *
 * A browser cannot put an `Authorization` header on a WebSocket — the API has
 * no room for one in the handshake — so a browser client connects as a
 * spectator and proves its wallet in a frame. Without this there is no path by
 * which any browser could ever subscribe to its own channel, which would make
 * §48.2's private events unreachable from the only client this product has.
 *
 * Subscriptions the new wallet may not see are dropped rather than kept. The
 * case that matters is signing out — `wallet` becomes `null` — and a connection
 * that kept its wallet channel through that would go on delivering one
 * player's private events to a session that is no longer theirs.
 */
export function identify(
  state: HubState,
  connectionId: string,
  wallet: WalletAddress | null,
): HubState {
  const connection = state.connections[connectionId];
  if (connection === undefined) {
    return state;
  }
  return {
    ...state,
    connections: {
      ...state.connections,
      [connectionId]: {
        wallet,
        channels: connection.channels.filter((channel) => maySubscribe(channel, wallet)),
      },
    },
  };
}

/**
 * Forgets a connection and everything it was listening to.
 *
 * The sequencer is deliberately untouched. Sequences belong to channels, not to
 * listeners — resetting one because its last subscriber left would make the
 * next subscriber see numbers it had already seen, and §70.7 teaches clients to
 * read that as a replay.
 */
export function disconnect(state: HubState, connectionId: string): HubState {
  const { [connectionId]: _gone, ...connections } = state.connections;
  return { ...state, connections };
}

export type SubscribeOutcome =
  | { readonly kind: 'SUBSCRIBED' }
  /** Already listening. Subscribing twice must not double-deliver. */
  | { readonly kind: 'ALREADY_SUBSCRIBED' }
  /** §48.2: a private channel this session does not own. */
  | { readonly kind: 'DENIED'; readonly reason: string }
  | { readonly kind: 'UNKNOWN_CONNECTION' };

export function subscribe(
  state: HubState,
  connectionId: string,
  channel: Channel,
): { readonly state: HubState; readonly outcome: SubscribeOutcome } {
  const connection = state.connections[connectionId];
  if (connection === undefined) {
    return { state, outcome: { kind: 'UNKNOWN_CONNECTION' } };
  }

  if (!maySubscribe(channel, connection.wallet)) {
    // Denied rather than silently ignored. A client that believes it is
    // subscribed and receives nothing cannot tell that from a quiet channel,
    // and will wait forever for an event that was never coming.
    return {
      state,
      outcome: {
        kind: 'DENIED',
        reason: 'That channel belongs to a wallet this session has not proven.',
      },
    };
  }

  if (connection.channels.includes(channel)) {
    return { state, outcome: { kind: 'ALREADY_SUBSCRIBED' } };
  }

  return {
    state: {
      ...state,
      connections: {
        ...state.connections,
        [connectionId]: { ...connection, channels: [...connection.channels, channel] },
      },
    },
    outcome: { kind: 'SUBSCRIBED' },
  };
}

export function unsubscribe(state: HubState, connectionId: string, channel: Channel): HubState {
  const connection = state.connections[connectionId];
  if (connection === undefined) {
    return state;
  }
  return {
    ...state,
    connections: {
      ...state.connections,
      [connectionId]: {
        ...connection,
        channels: connection.channels.filter((subscribed) => subscribed !== channel),
      },
    },
  };
}

export interface Delivery<TPayload> {
  readonly state: HubState;
  readonly envelope: Envelope<TPayload>;
  /** Connection ids to send it to. Empty when nobody is listening. */
  readonly recipients: readonly string[];
}

/**
 * Stamps an event and works out who receives it.
 *
 * The sequence advances whether or not anyone is listening. A channel's numbers
 * describe the channel's history, not one client's view of it — a subscriber
 * arriving later needs the sequence it joins at to mean the same thing as the
 * one everyone else already has, which is what makes §70.7's gap detection
 * work at all.
 */
export function publish<TPayload>(
  state: HubState,
  event: string,
  channel: Channel,
  at: UtcTimestamp,
  payload: TPayload,
): Delivery<TPayload> {
  const stamped = emit(state.sequencer, event, channel, at, payload);
  const recipients = Object.entries(state.connections)
    .filter(([, connection]) => connection.channels.includes(channel))
    .map(([connectionId]) => connectionId);

  return {
    state: { ...state, sequencer: stamped.state },
    envelope: stamped.envelope,
    recipients,
  };
}

/** The sequence a channel is currently at, for a snapshot to name (§24). */
export function currentSequence(state: HubState, channel: Channel): number {
  const next = state.sequencer[channel] ?? 0;
  // `emit` hands out the next number and then increments, so the last one
  // actually delivered is one behind. A snapshot that named the next sequence
  // would make the client treat the following event as a duplicate.
  return next - 1;
}

/** Which channels a connection is listening to. For diagnostics and tests. */
export function channelsOf(state: HubState, connectionId: string): readonly Channel[] {
  return state.connections[connectionId]?.channels ?? [];
}

/** How many connections are listening to a channel. */
export function subscriberCount(state: HubState, channel: Channel): number {
  return Object.values(state.connections).filter((connection) =>
    connection.channels.includes(channel),
  ).length;
}
