import type { Channel } from '@ponswars/realtime';

/**
 * What a client may send, and what it gets back (§48, §70.1).
 *
 * Four messages in, three out. §37.1 makes PonsWars a place rather than a page,
 * and a place needs very little protocol: say what you want to watch, stop
 * watching, and prove you are still there.
 *
 * Parsed defensively because this arrives from the network. A frame that is not
 * one of these is answered rather than ignored — a client sending something the
 * server silently drops has no way to learn it is wrong.
 */

export type ClientMessage =
  | { readonly type: 'SUBSCRIBE'; readonly channel: Channel }
  | { readonly type: 'UNSUBSCRIBE'; readonly channel: Channel }
  /** Liveness. The server answers `PONG` so a client can measure the round trip. */
  | { readonly type: 'PING'; readonly sentAt: number };

export type ServerMessage =
  /**
   * Accepted a subscription, and where the channel currently stands.
   *
   * `sequence` is the last event already delivered, so the client knows what
   * the next one should be. §24's reconnect flow depends on resuming from a
   * known point rather than assuming zero.
   */
  | { readonly type: 'SUBSCRIBED'; readonly channel: Channel; readonly sequence: number }
  | { readonly type: 'UNSUBSCRIBED'; readonly channel: Channel }
  | { readonly type: 'PONG'; readonly sentAt: number; readonly serverTime: number }
  /**
   * Something was refused, with a reason.
   *
   * §110.5's shape applies here too: a client told only "error" cannot tell a
   * bug of its own from a channel it is not entitled to.
   */
  | { readonly type: 'ERROR'; readonly code: string; readonly message: string };

/**
 * Parses a frame, or says why it could not.
 *
 * Returns a reason rather than throwing, because a malformed frame is a normal
 * thing to receive from the internet and not an exceptional one.
 */
export function parseClientMessage(raw: string): ClientMessage | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: 'Frame is not JSON.' };
  }

  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return { error: 'Frame has no type.' };
  }
  const message = value as Record<string, unknown>;

  switch (message['type']) {
    case 'SUBSCRIBE':
    case 'UNSUBSCRIBE': {
      const channel = message['channel'];
      if (typeof channel !== 'string' || channel.length === 0) {
        return { error: `${message['type']} needs a channel.` };
      }
      return { type: message['type'], channel };
    }
    case 'PING': {
      const sentAt = message['sentAt'];
      if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) {
        return { error: 'PING needs a numeric sentAt.' };
      }
      return { type: 'PING', sentAt };
    }
    default:
      return { error: `Unknown message type ${String(message['type'])}.` };
  }
}
