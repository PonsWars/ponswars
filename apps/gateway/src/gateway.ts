import {
  connect,
  currentSequence,
  disconnect,
  EMPTY_HUB,
  identify,
  publish,
  subscribe,
  unsubscribe,
  type Channel,
  type Envelope,
  type HubState,
} from '@ponswars/realtime';
import type { PublisherPort } from '@ponswars/round-service';
import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';
import { parseClientMessage, type ServerMessage } from './protocol.js';

/**
 * The gateway, minus the sockets (§48, §70).
 *
 * Every decision belongs to the hub reducer in `@ponswars/realtime`; this owns
 * the mutable registry of who is connected and the function that turns an
 * envelope into a frame. Splitting it that way means the socket library appears
 * in exactly one file, and swapping it changes nothing about authorisation,
 * sequencing or fan-out.
 *
 * It implements `PublisherPort`, so the round loop publishes through the same
 * interface an in-memory test double satisfies. The loop does not know a socket
 * exists.
 */

/**
 * How many channels one connection may follow.
 *
 * A client watching everything it can use follows the world, the round, five
 * battles and its own wallet — eight. This is four times that, and it exists
 * because every subscription is state this process keeps for as long as the
 * connection lives.
 */
export const MAX_SUBSCRIPTIONS = 32;

/** How a frame reaches one client. The socket binding supplies this. */
export type Send = (connectionId: string, frame: string) => void;

export class Gateway implements PublisherPort {
  private hub: HubState = EMPTY_HUB;

  constructor(
    private readonly send: Send,
    private readonly now: () => UtcTimestamp,
  ) {}

  /** A client connected. `wallet` is `null` for a spectator (§5). */
  open(connectionId: string, wallet: WalletAddress | null): void {
    this.hub = connect(this.hub, connectionId, wallet);
  }

  close(connectionId: string): void {
    this.hub = disconnect(this.hub, connectionId);
  }

  /**
   * A connection proved a wallet, or signed out (§48.2, §45.2).
   *
   * Separate from `receive` because resolving a session token is a database
   * read and everything else here is a pure state transition. The socket
   * binding does the asking — it is the half that knows what a token is — and
   * hands the answer here, which keeps this class free of IO exactly as the
   * hub is free of sockets.
   *
   * Answers `AUTHENTICATED` even when the wallet is `null`. A client that
   * offered a token and heard nothing cannot tell a rejected token from a slow
   * one.
   */
  identify(connectionId: string, wallet: WalletAddress | null): void {
    this.hub = identify(this.hub, connectionId, wallet);
    this.reply(connectionId, { type: 'AUTHENTICATED', wallet });
  }

  /**
   * Handles one frame from a client.
   *
   * Every path answers. A silently dropped frame leaves the client believing
   * something happened, and the failure surfaces much later as an event that
   * never arrives.
   */
  receive(connectionId: string, raw: string): void {
    const message = parseClientMessage(raw);
    if ('error' in message) {
      this.reply(connectionId, { type: 'ERROR', code: 'BAD_FRAME', message: message.error });
      return;
    }

    switch (message.type) {
      case 'SUBSCRIBE': {
        const channels = this.hub.connections[connectionId]?.channels ?? [];
        if (!channels.includes(message.channel) && channels.length >= MAX_SUBSCRIPTIONS) {
          this.reply(connectionId, {
            type: 'ERROR',
            code: 'TOO_MANY_SUBSCRIPTIONS',
            message: `A connection may follow at most ${String(MAX_SUBSCRIPTIONS)} channels. Unsubscribe from one first.`,
          });
          return;
        }
        const result = subscribe(this.hub, connectionId, message.channel);
        this.hub = result.state;

        switch (result.outcome.kind) {
          case 'SUBSCRIBED':
          case 'ALREADY_SUBSCRIBED':
            // Both answer the same way. A client that resubscribes after a
            // reconnect it was unsure about should get a usable sequence
            // rather than an error it has to interpret.
            this.reply(connectionId, {
              type: 'SUBSCRIBED',
              channel: message.channel,
              sequence: currentSequence(this.hub, message.channel),
            });
            return;
          case 'DENIED':
            this.reply(connectionId, {
              type: 'ERROR',
              code: 'FORBIDDEN_CHANNEL',
              message: result.outcome.reason,
            });
            return;
          case 'UNKNOWN_CONNECTION':
            this.reply(connectionId, {
              type: 'ERROR',
              code: 'UNKNOWN_CONNECTION',
              message: 'This connection is not registered.',
            });
            return;
        }
        // Unreachable: the switch above covers every outcome and each returns.
        // Stated anyway, because `no-fallthrough` reasons syntactically and a
        // case that falls into the next one is a real bug worth never risking.
        return;
      }

      case 'UNSUBSCRIBE':
        this.hub = unsubscribe(this.hub, connectionId, message.channel);
        this.reply(connectionId, { type: 'UNSUBSCRIBED', channel: message.channel });
        return;

      case 'PING':
        // §23.5: the client measures its offset against server time rather than
        // trusting its own clock. Echoing `sentAt` is what lets it compute the
        // round trip without keeping state.
        this.reply(connectionId, {
          type: 'PONG',
          sentAt: message.sentAt,
          serverTime: this.now(),
        });
        return;
    }
  }

  /**
   * `PublisherPort`: stamps an event and fans it out.
   *
   * Async to satisfy the port, but nothing here awaits — a socket write is
   * fire-and-forget, and making the round loop wait on the slowest subscriber
   * would let one stalled connection delay a battle tick for everyone.
   */
  publish(event: string, channel: Channel, at: UtcTimestamp, payload: unknown): Promise<void> {
    const delivery = publish(this.hub, event, channel, at, payload);
    this.hub = delivery.state;

    const frame = JSON.stringify(delivery.envelope);
    for (const connectionId of delivery.recipients) {
      this.send(connectionId, frame);
    }
    return Promise.resolve();
  }

  /** The hub, for diagnostics. Read-only by convention; the reducers are pure. */
  state(): HubState {
    return this.hub;
  }

  private reply(connectionId: string, message: ServerMessage): void {
    this.send(connectionId, JSON.stringify(message));
  }
}

/** Re-exported so a caller can type what it receives without a second import. */
export type { Envelope };
