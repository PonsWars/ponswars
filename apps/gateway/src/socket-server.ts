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
   */
  readonly walletOf: (authorization: string | undefined) => WalletAddress | null;
}

export interface RunningSocketServer {
  readonly gateway: Gateway;
  readonly wss: WebSocketServer;
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

  wss.on('connection', (socket, request) => {
    const connectionId = randomUUID();
    sockets.set(connectionId, socket);
    gateway.open(connectionId, options.walletOf(request.headers.authorization));

    socket.on('message', (data) => {
      gateway.receive(connectionId, decodeFrame(data));
    });

    const forget = (): void => {
      sockets.delete(connectionId);
      gateway.close(connectionId);
    };
    socket.on('close', forget);
    // A socket that errors is gone whether or not `close` follows, and leaving
    // it registered would keep sending frames nobody receives.
    socket.on('error', forget);
  });

  return {
    gateway,
    wss,
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
