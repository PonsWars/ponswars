import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { Gateway } from './gateway.js';

/**
 * The only file that knows what a socket is.
 *
 * Everything above it — authorisation, sequencing, fan-out, the protocol —
 * happens without one. This turns a connection into an id, a frame into a
 * string, and a string back into a frame, and that is the whole job.
 *
 * Keeping it this thin is what makes the socket library a swappable detail
 * rather than an architecture. Nothing here decides anything.
 */

export interface SocketServerOptions {
  /** An existing HTTP server to attach to, or a port to listen on directly. */
  readonly server?: Server;
  readonly port?: number;
  readonly now: () => UtcTimestamp;
  /**
   * Resolves the wallet a connection has proven, from its request.
   *
   * `null` is a spectator, which §5 makes the normal case rather than a
   * degraded one. Signature verification is §45.2 and belongs to the auth
   * service; this takes its answer.
   *
   * Asynchronous because a session lives in a database — it has to survive a
   * restart and be revocable — so the connection is held paused until it
   * answers rather than opened as a spectator and corrected afterwards.
   */
  readonly walletOf: (authorization: string | undefined) => Promise<WalletAddress | null>;
}

export interface RunningSocketServer {
  readonly gateway: Gateway;
  readonly wss: WebSocketServer;
  /**
   * Resolves once the server is accepting connections, and rejects if it never
   * gets there.
   *
   * `ws` reports a failed bind by emitting `error` on the server. With no
   * listener that is an unhandled event: the process dies with a stack trace,
   * and it dies *later* than the call that caused it, so anything started in
   * between has already taken its own ports. Handing the caller a promise makes
   * a bind failure something it can act on before it binds anything else.
   *
   * Only startup is settled here. An error after the server is listening is
   * left unhandled exactly as before, because a socket server failing while
   * serving should be loud rather than swallowed by a promise nobody is
   * awaiting any more.
   */
  readonly ready: Promise<void>;
  close: () => Promise<void>;
}

export function startSocketServer(options: SocketServerOptions): RunningSocketServer {
  const sockets = new Map<string, WebSocket>();

  /**
   * The wallet behind a token, and never a thrown error.
   *
   * A session store that is unreachable makes a connection a spectator here,
   * unlike at connection time where it closes the socket. The difference is
   * what the client is doing: at connect it has just loaded and can retry
   * cleanly, while here it is a live connection watching a round, and taking
   * that away is worse than answering "you are watching as a spectator" — which
   * the client can see and act on.
   */
  const resolve = (token: string): Promise<WalletAddress | null> =>
    token === '' ? Promise.resolve(null) : options.walletOf(`Bearer ${token}`).catch(() => null);

  const gateway = new Gateway((connectionId, frame) => {
    const socket = sockets.get(connectionId);
    // `readyState === OPEN` rather than a try/catch: a socket that closed
    // between the fan-out and the write is ordinary, not exceptional, and a
    // thrown error here would abort delivery to everyone after it.
    if (socket !== undefined && socket.readyState === socket.OPEN) {
      socket.send(frame);
    }
  }, options.now);

  const wss =
    options.server === undefined
      ? new WebSocketServer({ port: options.port ?? 0 })
      : new WebSocketServer({ server: options.server });

  // Attached to an existing server, binding is the caller's business and
  // already done; `ws` emits no `listening` of its own in that case, so waiting
  // for one would hang forever.
  const ready =
    options.server === undefined
      ? new Promise<void>((resolve, reject) => {
          const onListening = (): void => {
            wss.off('error', onError);
            resolve();
          };
          const onError = (error: Error): void => {
            wss.off('listening', onListening);
            reject(error);
          };
          wss.once('listening', onListening);
          wss.once('error', onError);
        })
      : Promise.resolve();

  wss.on('connection', (socket, request) => {
    const connectionId = randomUUID();
    sockets.set(connectionId, socket);

    let opened = false;

    /**
     * Frames handled strictly in order, including the ones that wait.
     *
     * Two things here are asynchronous now: opening a connection resolves a
     * session (§45.2), and so does `AUTHENTICATE`. Both change *who* the
     * connection is, and a `SUBSCRIBE` that overtook either would be decided
     * against the wrong wallet — a player's own channel refused as a
     * spectator's, or a signed-out session still holding one.
     *
     * A promise chain rather than pausing the socket, because pausing does not
     * do this: `ws` has already parsed whatever arrived in the same read, and
     * emits those frames regardless. Two frames sent in one tick — which is
     * exactly what signing in and subscribing looks like — arrive together.
     */
    let queue: Promise<void> = options.walletOf(request.headers.authorization).then(
      (wallet) => {
        if (socket.readyState !== socket.OPEN) {
          // Closed while we were asking. Nothing was opened, so there is
          // nothing to close.
          sockets.delete(connectionId);
          return;
        }
        gateway.open(connectionId, wallet);
        opened = true;
      },
      () => {
        // The session store is unreachable. §5 makes spectating the normal
        // case, so the tempting thing is to carry on as a spectator — and that
        // would silently downgrade a player mid-round. Closing says what
        // happened and lets the client retry.
        sockets.delete(connectionId);
        socket.close(1011, 'authentication unavailable');
      },
    );

    const handle = async (raw: string): Promise<void> => {
      // The connection never opened — the lookup failed and the socket is on
      // its way out. There is nothing to receive this into.
      if (!opened) {
        return;
      }

      // `AUTHENTICATE` is the one frame this layer answers itself, because it
      // is the one that needs a session store. Everything else is a pure state
      // transition and belongs to the gateway.
      const token = authenticateToken(raw);
      if (token === null) {
        gateway.receive(connectionId, raw);
        return;
      }
      gateway.identify(connectionId, await resolve(token));
    };

    socket.on('message', (data) => {
      const raw = decodeFrame(data);
      // Chained, never awaited here: the handler is synchronous, and the queue
      // is what carries the order. A failure is swallowed rather than left to
      // poison every frame behind it.
      queue = queue.then(() => handle(raw)).catch(() => undefined);
    });

    const forget = (): void => {
      sockets.delete(connectionId);
      if (opened) {
        gateway.close(connectionId);
      }
    };
    socket.on('close', forget);
    // A socket that errors is gone whether or not `close` follows, and leaving
    // it registered would keep sending frames nobody receives.
    socket.on('error', forget);
  });

  return {
    gateway,
    wss,
    ready,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets.values()) {
          socket.close();
        }
        sockets.clear();
        wss.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

/**
 * Turns a received frame into text.
 *
 * `ws` hands back one of three shapes, and a fragmented message arrives as an
 * array of buffers. Calling `toString()` on that array yields
 * `[object Object]` — valid JavaScript, silently wrong, and only ever seen on
 * messages large enough to be split, which is exactly the kind of bug that
 * survives every small test and fails in production.
 */
export function decodeFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

/**
 * The token from an `AUTHENTICATE` frame, or `null` for anything else.
 *
 * A narrow, allocation-cheap look rather than a full parse: every other frame
 * is parsed once, by the gateway, and this must not become a second place that
 * decides what a frame means. An empty-string token is a real answer — it is
 * how a client says it has signed out — which is why absence is `null` and not
 * an empty string.
 */
export function authenticateToken(raw: string): string | null {
  // Cheap enough to run on every frame, and skips the parse for the ones that
  // could not possibly be this.
  if (!raw.includes('AUTHENTICATE')) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const frame = value as Record<string, unknown>;
  return frame['type'] === 'AUTHENTICATE' && typeof frame['token'] === 'string'
    ? frame['token']
    : null;
}
