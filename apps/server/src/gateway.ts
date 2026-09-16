import { AuthService } from '@ponswars/auth';
import { ConfigError, loadConfig } from '@ponswars/config';
import { bearer } from '@ponswars/api';
import { connectPostgres } from '@ponswars/postgres';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { redisEventBus } from '@ponswars/redis';
import { PostgresAuthStore } from '@ponswars/store-postgres';
import { startSocketServer } from '@ponswars/gateway';
import { utcTimestamp, type UtcTimestamp, type WalletAddress } from '@ponswars/shared-types';

/**
 * The realtime tier, on its own (§21.3, §48).
 *
 * A second entry point in the server image, beside `migrate.js` and
 * `rewards-worker.js`:
 *
 *   node dist/gateway.js
 *
 * §5 makes spectating the normal case, and the two halves of this service do
 * not grow together: `docs/operations/load-testing.md` measures 2,500 watchers
 * against a few hundred sign-ins, and the watchers are the cheap half to add
 * machines for. Running them in the same process as the round driver also puts
 * socket fan-out on the event loop that scores battles — measurable, at the
 * tail, with five hundred sign-ins in flight.
 *
 * It decides nothing. It holds connections, resolves who each one is, and
 * delivers what the bus publishes; the driver that publishes is somewhere else
 * (§70.1 keeps the sequence with the publisher, so this delivers rather than
 * numbers). A deployment can run several, and each delivers to its own
 * connections.
 *
 * `node dist/main.js --no-sockets` is the other half of this: a server told
 * that its sockets live elsewhere. Run neither flag nor this process and one
 * process still serves everything, which is what a single-instance deployment
 * wants.
 *
 * ## Configuration
 *
 * The same environment as the server — it is the same image and the same
 * `.env`. What it actually reads: `GATEWAY_PORT`, `REDIS_URL` for the events,
 * `DATABASE_URL` and the `AUTH_` values to answer who a connection is.
 */

/** Health, on the port the sockets are on, so one probe covers the process. */
const HEALTH_PATH = '/v1/health';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const now = (): UtcTimestamp => utcTimestamp(Date.now());

  // Sessions only. This process verifies no signatures — a connection arrives
  // holding a token the API already issued — so it needs the store and none of
  // the threads the API spreads recovery over.
  const database = connectPostgres({
    connectionString: config.DATABASE_URL,
    // Reads, one per connection opened, and nothing long-running. Small on
    // purpose: a socket tier is the part a deployment adds instances of, and
    // each one holding ten idle connections is how a managed database runs out.
    maxConnections: 4,
  });
  const auth = new AuthService({
    store: new PostgresAuthStore(database),
    policy: {
      challengeTtlMs: config.AUTH_CHALLENGE_TTL_MS,
      sessionTtlMs: config.AUTH_SESSION_TTL_MS,
      domain: new URL(config.AUTH_ORIGIN).host,
      uri: config.AUTH_ORIGIN,
      chainId: config.CHAIN_ID,
    },
    now,
  });
  const walletOf = (authorization: string | undefined): Promise<WalletAddress | null> => {
    const token = bearer(authorization);
    return token === null ? Promise.resolve(null) : auth.walletOf(token);
  };

  // The upgrade and the health check on one port. An orchestrator that can only
  // probe HTTP can still tell whether this process is alive, and an ingress
  // needs one route rather than two.
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url === HEALTH_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'not found' }));
  });

  const sockets = startSocketServer({ server: http, now, walletOf });
  const bus = await redisEventBus({
    url: config.REDIS_URL,
    onProblem: (problem) => {
      say(`${problem}\n`);
    },
  });
  await bus.subscribe((envelope) => {
    sockets.gateway.deliver(envelope);
  });

  await new Promise<void>((resolve, reject) => {
    // Bound last. A process that failed to bind after subscribing would sit on
    // the bus delivering to nobody, which looks healthy from the outside.
    http.once('error', reject);
    http.listen(config.GATEWAY_PORT, '0.0.0.0', () => {
      http.off('error', reject);
      resolve();
    });
  });

  say(`gateway listening on :${String(config.GATEWAY_PORT)} — sockets and ${HEALTH_PATH}\n`);

  const stopped = new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      say(`\n${signal} — closing connections\n`);
      resolve();
    };
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
  });
  await stopped;

  // Sockets first: a client told the server is going away reconnects to
  // another instance, which is the whole point of there being more than one.
  await sockets.close();
  await new Promise<void>((resolve) =>
    http.close(() => {
      resolve();
    }),
  );
  await bus.close();
  await database.close();
  say('stopped cleanly\n');
}

function say(line: string): void {
  process.stdout.write(line);
}

main().catch((error: unknown) => {
  const refused = error instanceof ConfigError;
  process.stderr.write(
    `${refused ? 'refused' : 'gateway failed'}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
