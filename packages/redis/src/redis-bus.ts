import { PROTOCOL_VERSION, type Channel, type Envelope } from '@ponswars/realtime';
import type { PublisherPort } from '@ponswars/round-service';
import { utcTimestamp, type UtcTimestamp } from '@ponswars/shared-types';
import { createClient, type RedisClientType } from 'redis';

/**
 * Realtime events across instances (§21.3, §48.5, §70.1).
 *
 * One process drives the rounds and publishes; every process serving sockets
 * has to deliver what it published, to its own connections. In one process the
 * gateway is both and nothing crosses a boundary. Past one, something has to
 * carry the event — that is this, over Redis, which §21.3 already names for
 * pub/sub.
 *
 * ## Why the sequence is Redis' and not a process's
 *
 * §70.1 makes the sequence monotonic within a channel, and §24 teaches clients
 * to fetch a snapshot when they see a gap. A number kept per process would
 * restart at one wherever the publisher moved, and every client on every other
 * instance would read that as a gap — or worse, as a duplicate. `INCR` gives
 * one counter per channel for the whole deployment, which is what the protocol
 * actually promises.
 *
 * ## What it does not do
 *
 * Replay. Redis pub/sub delivers to whoever is listening at the time, and an
 * instance that was starting up missed it. That is the same gap a dropped
 * frame leaves, and §24's answer covers both: the client notices the sequence
 * jump and re-fetches. A bus with a backlog would be a second source of truth
 * for something the snapshot already answers.
 */

export interface EventBus extends PublisherPort {
  /** Called for every event published by any instance, this one included. */
  subscribe(deliver: (envelope: Envelope<unknown>) => void): Promise<void>;
  close(): Promise<void>;
}

/** The Redis channel every instance listens on. */
const EVENTS_CHANNEL = 'ponswars:events';

/** Where a channel's sequence lives. */
const sequenceKey = (channel: Channel): string => `ponswars:seq:${channel}`;

export interface RedisEventBusOptions {
  readonly url: string;
  /** Told when the connection drops or an event cannot be read; never thrown at a round. */
  readonly onProblem?: (problem: string) => void;
}

export async function redisEventBus(options: RedisEventBusOptions): Promise<EventBus> {
  const say = options.onProblem ?? ((): void => undefined);
  // Two connections: a client in subscriber mode may not run commands, and the
  // publisher has to `INCR`.
  const publisher: RedisClientType = createClient({ url: options.url });
  const subscriber: RedisClientType = publisher.duplicate();
  for (const [name, client] of [
    ['publisher', publisher],
    ['subscriber', subscriber],
  ] as const) {
    client.on('error', (error: unknown) => {
      say(`redis ${name}: ${String(error)}`);
    });
  }
  await publisher.connect();
  await subscriber.connect();

  return {
    async publish(event: string, channel: Channel, at: UtcTimestamp, payload: unknown) {
      // `INCR` returns the value after incrementing and the hub numbers a
      // channel from zero, so the first event either way is zero.
      const sequence = (await publisher.incr(sequenceKey(channel))) - 1;
      const envelope: Envelope<unknown> = {
        event,
        version: PROTOCOL_VERSION,
        sequence,
        emittedAt: at,
        channel,
        payload,
      };
      await publisher.publish(EVENTS_CHANNEL, JSON.stringify(envelope));
    },

    async subscribe(deliver) {
      await subscriber.subscribe(EVENTS_CHANNEL, (message: string) => {
        const envelope = readEnvelope(message);
        if (envelope === null) {
          // Another deployment on the same Redis, or a version that publishes
          // something this one does not read. Neither is this process's
          // business, and neither is worth dropping a connection over.
          say('an event on ponswars:events was not one this version reads');
          return;
        }
        deliver(envelope);
      });
    },

    async close() {
      await subscriber.quit().catch(() => undefined);
      await publisher.quit().catch(() => undefined);
    },
  };
}

/** An envelope from the wire, or `null` if that is not what it is. */
function readEnvelope(message: string): Envelope<unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const frame = value as Record<string, unknown>;
  if (
    typeof frame['event'] !== 'string' ||
    typeof frame['channel'] !== 'string' ||
    typeof frame['sequence'] !== 'number' ||
    typeof frame['emittedAt'] !== 'number' ||
    frame['version'] !== PROTOCOL_VERSION
  ) {
    return null;
  }
  return {
    event: frame['event'],
    version: PROTOCOL_VERSION,
    sequence: frame['sequence'],
    emittedAt: utcTimestamp(frame['emittedAt']),
    channel: frame['channel'],
    payload: frame['payload'],
  };
}
