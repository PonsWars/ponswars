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

    // Paused until the wallet is known. Resolving a session is a database read
    // now (§45.2), and a client that subscribes in its first frame would
    // otherwise be answered by a gateway that had not opened its connection
    // yet — a spectator's subscription refused, or worse, a player's accepted
    // as a spectator's. `pause` stops the socket being read at all, so the
    // frames simply arrive a few milliseconds later, in order.
    socket.pause();

    let opened = false;

    socket.on('message', (data) => {
      // A frame cannot arrive before the connection opens — the socket is
      // paused until then — but it can arrive after the lookup failed and the
      // socket was resumed to close it cleanly. There is no connection to
      // receive it into.
      if (opened) {
        gateway.receive(connectionId, decodeFrame(data));
      }
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

    void options.walletOf(request.headers.authorization).then(
      (wallet) => {
        if (socket.readyState !== socket.OPEN) {
          // Closed while we were asking. Nothing was opened, so there is
          // nothing to close.
          sockets.delete(connectionId);
          return;
        }
        gateway.open(connectionId, wallet);
        opened = true;
        socket.resume();
      },
      () => {
        // The session store is unreachable. §5 makes spectating the normal
        // case, so the tempting thing is to carry on as a spectator — and that
        // would silently downgrade a player mid-round. Closing says what
        // happened and lets the client retry.
        sockets.delete(connectionId);
        // Resumed first, or the close never completes: a closing handshake ends
        // when the peer's own close frame is read, and a paused socket reads
        // nothing. The connection would sit half-closed until a timeout.
        socket.resume();
        socket.close(1011, 'authentication unavailable');
      },
    );
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
