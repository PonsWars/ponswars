import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';

/**
 * The WebSocket envelope and per-channel sequencing (§70.1, §48.5).
 *
 * Every event carries a channel and a sequence that is monotonic **within that
 * channel**. §24 requires a client that misses events to fetch a snapshot
 * rather than assume perfect delivery, and a per-channel sequence is what makes
 * "I missed something" detectable rather than guessed at.
 */

/** Protocol version, bumped when the envelope shape changes (§70.1). */
export const PROTOCOL_VERSION = 1;

export type Channel = string;

export interface Envelope<TPayload> {
  readonly event: string;
  readonly version: number;
  /** Monotonic within `channel`. Not global — channels advance independently. */
  readonly sequence: number;
  readonly emittedAt: UtcTimestamp;
  readonly channel: Channel;
  readonly payload: TPayload;
}

// ---------------------------------------------------------------------------
// Channels (§48.1, §48.2)
// ---------------------------------------------------------------------------

export const WORLD_CHANNEL = 'world';

export const roundChannel = (roundId: string): Channel => `round:${roundId}`;
export const battleChannel = (battleId: string): Channel => `battle:${battleId}`;
export const walletChannel = (wallet: WalletAddress): Channel => `wallet:${wallet}`;

/**
 * Whether a string names a channel this protocol defines (§48.1).
 *
 * The world, a round, a battle, or a wallet — and nothing else. A server that
 * accepted any string as a channel would keep a subscription to whatever a
 * client invented, and a client can invent them faster than a server can
 * store them.
 */
export function isChannel(value: string): boolean {
  return (
    value === WORLD_CHANNEL ||
    /^(round|battle):[A-Za-z0-9_-]{1,96}$/.test(value) ||
    /^wallet:0x[0-9a-f]{40}$/.test(value)
  );
}

/**
 * Whether a session may subscribe to a channel.
 *
 * §48.2: a private channel *"requires authenticated session ownership of that
 * wallet address."* Public channels are open — §5 keeps PonsWars fully
 * watchable without connecting, so requiring authentication to watch would
 * break the spectator promise.
 *
 * The comparison is exact, on lowercase addresses. `walletChannel` builds from
 * an already-normalized `WalletAddress`, so a mixed-case subscription request
 * simply does not match rather than being silently accepted.
 */
export function maySubscribe(channel: Channel, sessionWallet: WalletAddress | null): boolean {
  if (!channel.startsWith('wallet:')) {
    return true;
  }
  if (sessionWallet === null) {
    return false;
  }
  return channel === walletChannel(sessionWallet);
}

// ---------------------------------------------------------------------------
// Server-side sequencing
// ---------------------------------------------------------------------------

/** Next sequence number per channel. Serialisable, so it survives a restart. */
export type SequencerState = Readonly<Record<Channel, number>>;

export const EMPTY_SEQUENCER: SequencerState = {};

/**
 * Stamps an event with the next sequence for its channel.
 *
 * Sequences start at zero and never skip. A gap in what a client receives
 * therefore means a lost message rather than a server that numbered oddly —
 * which is the whole basis of §70.7 recovery.
 */
export function emit<TPayload>(
  state: SequencerState,
  event: string,
  channel: Channel,
  emittedAt: UtcTimestamp,
  payload: TPayload,
): { readonly state: SequencerState; readonly envelope: Envelope<TPayload> } {
  const sequence = state[channel] ?? 0;
  return {
    state: { ...state, [channel]: sequence + 1 },
    envelope: {
      event,
      version: PROTOCOL_VERSION,
      sequence,
      emittedAt,
      channel,
      payload,
    },
  };
}
