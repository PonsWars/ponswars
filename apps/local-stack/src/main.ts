import { bearer, buildServer, PickStore } from '@ponswars/api';
import { MemoryPlayerRecords } from '@ponswars/player-service';
import { AuthService, MemoryAuthStore, workerRecovery, type AuthPolicy } from '@ponswars/auth';
import {
  CURRENT_ENGINE_VERSIONS,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import { RATIO_SCALE, type ConfidenceCalibration } from '@ponswars/battle-math';
import { startSocketServer } from '@ponswars/gateway';
import {
  MemoryCardHoldings,
  MemoryRoundStore,
  runRounds,
  type DriverEvent,
  type RoundPorts,
} from '@ponswars/round-service';
import {
  milliseconds,
  ROBINHOOD_CHAIN_TESTNET_ID,
  utcTimestamp,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { SyntheticMarket } from '@ponswars/market-data';
import { redisEventBus, takeLease, type Lease } from '@ponswars/redis';
import { connectPostgres } from '@ponswars/postgres';
import {
  PostgresAuthStore,
  PostgresCardHoldings,
  PostgresPickStore,
  PostgresPlayerRecords,
  PostgresRoundStore,
  readFinalizedResult,
} from '@ponswars/store-postgres';

/**
 * The whole loop, running locally (§68).
 *
 * One process: the round orchestrator, the HTTP API and the WebSocket gateway,
 * wired to each other through the ports they already define. Rounds open, take
 * picks, lock, tick for nine minutes and finalize, and anything connected
 * watches it happen.
 *
 * **Development only.** Two of the five ports are stand-ins: the market is
 * synthetic and the store is in memory. Both are deliberate — the market-data
 * vendor and the database are `OPEN` (§102), and a stack that quietly picked
 * one would be shipping that decision as policy. What this proves is that the
 * seam is real: replacing either is one constructor argument.
 *
 * It is named `local-stack` and says so on startup, because the failure mode
 * for a thing like this is somebody running it and believing it.
 */

const PORT_API = Number(process.env['PORT_API'] ?? 4000);
const PORT_WS = Number(process.env['PORT_WS'] ?? 4001);

/**
 * How long the rounds lease lives without renewal.
 *
 * Long enough that an ordinary pause does not hand the rounds to somebody
 * else, short enough that a crashed leader is replaced inside a round: ten
 * seconds against a ten-minute round (§3.1).
 */
const LEASE_TTL_MS = 10_000;

/**
 * Scoring tick interval (§12.5, §23.1).
 *
 * `BASELINE` rather than `OPEN`: the masterplan names approximately one
 * authoritative tick per second, so this is the documented figure rather than
 * an invented one. Stated explicitly because the loop would otherwise tick as
 * fast as it spins — the first run of this stack emitted four updates a second,
 * which is not the cadence the product describes and would be four times the
 * realtime volume a client is built to receive.
 */
const TICK_MS = Number(process.env['BATTLE_ENGINE_TICK_MS'] ?? 1_000);

/**
 * Engine calibration for the local stack.
 *
 * `OPEN` production tuning (§59.4). These are the simulation's values, chosen
 * because they are the ones every test in this repository already exercises —
 * not because they are recommended for production, which is a decision that has
 * not been made.
 */
const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 20n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

/**
 * Where each confidence band begins for this stack (§10.1, §102).
 *
 * `OPEN`, like the scoring calibration above, and chosen the same way: by
 * measuring what the synthetic market actually produces so that all six labels
 * in §10.2 are reachable. Bands copied from a real venue would be worse than
 * useless here, because this market is not that venue.
 *
 * The matchup gaps were measured the same way the market's step size was —
 * two thousand sides across two hundred rounds of this market:
 *
 * |        gaps | EVEN | FAVORED | UNDERDOG | STRONG_FAV | DOMINANT |
 * | ----------: | ---: | ------: | -------: | ---------: | -------: |
 * | *20/60/120* | *24%* |  *24%* |    *37%* |       *13%* |     *1%* |
 * |   40/80/140 |  51% |     17% |      24% |         7% |       0% |
 * |   45/85/145 |  59% |     15% |      20% |         5% |       0% |
 *
 * 20/60/120 keeps all six labels in play and keeps `DOMINANT` rare. Widening
 * the first gap looks more cautious and is worse: at 40 more than half of all
 * matchups open `EVEN`, which is a screen that tells a player nothing. That
 * `UNDERDOG` outnumbers `FAVORED` is not an imbalance — §10.2's two favourite
 * tiers both face one underdog tier, by design.
 *
 * One honest limitation. The walk's increments are independent, so its
 * direction reverses on about half of all steps whatever the trend — momentum
 * stability therefore varies around that average rather than telling a trending
 * stretch from a choppy one. The bands below split what the walk does produce,
 * so the signal is present and moves; it just carries less meaning here than it
 * would against a real series. That is a property of the stand-in market, not
 * of §10.1.
 */
const CONFIDENCE_CALIBRATION: ConfidenceCalibration = {
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: 1_167_000n, weak: 1_033_000n },
  ponsActivity: { high: 40n, medium: 20n },
  momentumStability: { stable: 26, mixed: 32 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

/**
 * Browser origins this stack serves (§5).
 *
 * Development only, like everything else here. A deployment names its own, and
 * `packages/config` is where that belongs once there is one.
 */
const WEB_ORIGINS = (process.env['WEB_ORIGINS'] ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

const now = (): UtcTimestamp => utcTimestamp(Date.now());

/**
 * Sign-in policy for the local stack (§45.2).
 *
 * The real flow — a wallet signs an EIP-4361 challenge, the signature is
 * verified, a session comes back — against an in-memory store. A restart signs
 * everyone out, which is the one thing about this that is local: a deployment
 * keeps sessions in PostgreSQL so a deploy does not.
 *
 * Five minutes and a day are this stack's numbers, not recommendations. Both
 * are `OPEN` (§102) and a deployment sets them.
 */
const AUTH_POLICY: AuthPolicy = {
  challengeTtlMs: 300_000,
  sessionTtlMs: 86_400_000,
  domain: 'localhost:5173',
  uri: 'http://localhost:5173',
  // Robinhood Chain Testnet, the network PonsWars runs on. The stack signs
  // nothing on chain; what this decides is which chain a signature must name,
  // and a local default is the testnet rather than mainnet.
  chainId: ROBINHOOD_CHAIN_TESTNET_ID,
};

async function main(): Promise<void> {
  // Set once the rounds lease is taken, if there is one to take. Declared up
  // here because what this instance serves depends on whether it is driving.
  let lease: Lease | null = null;

  // The store is the one thing this stack will take from a deployment: set
  // DATABASE_URL and it runs the same PostgreSQL adapters the server runs,
  // against a database `pnpm run db:migrate` has migrated. That is the claim
  // this stack exists to demonstrate — a port is one constructor argument —
  // and a claim nobody can run is not one.
  const databaseUrl = process.env['DATABASE_URL'];
  const database =
    databaseUrl === undefined || databaseUrl === ''
      ? null
      : connectPostgres({ connectionString: databaseUrl, maxConnections: 10 });

  // No card holdings in memory: the local stack records no Genesis claims, so
  // no wallet can arm a card here — exactly as in production until claims are
  // recorded.
  const cards = database === null ? new MemoryCardHoldings() : new PostgresCardHoldings(database);
  const picks = database === null ? new PickStore(cards) : new PostgresPickStore(database);
  const memoryStore = new MemoryRoundStore();
  const store = database === null ? memoryStore : new PostgresRoundStore(database);
  const market = new SyntheticMarket();
  // The same spread over cores the deployable server uses, so a load test
  // against this stack measures what a deployment would do.
  const recovery = workerRecovery();
  const auth = new AuthService({
    store: database === null ? new MemoryAuthStore() : new PostgresAuthStore(database),
    policy: AUTH_POLICY,
    now,
    ...(recovery === null ? {} : { recover: recovery.recover }),
  });

  const walletOf = (authorization: string | undefined): Promise<WalletAddress | null> => {
    const token = bearer(authorization);
    return token === null ? Promise.resolve(null) : auth.walletOf(token);
  };

  const sockets = startSocketServer({ port: PORT_WS, now, walletOf });

  // Events across instances, when there is more than one (§21.3). With
  // REDIS_URL the publisher is the bus: every instance's gateway delivers what
  // any instance published, with the sequence Redis assigned. Without it, this
  // process publishes to its own connections and there is nobody else to tell.
  const redisUrl = process.env['REDIS_URL'];
  const bus =
    redisUrl === undefined || redisUrl === ''
      ? null
      : await redisEventBus({
          url: redisUrl,
          onProblem: (problem) => {
            process.stdout.write(`${problem}\n`);
          },
        });
  await bus?.subscribe((envelope) => {
    sockets.gateway.deliver(envelope);
  });

  // Before anything else binds. A failed WebSocket bind surfaces a tick later
  // than the call that caused it, so without this the API port was already
  // taken by the time the process died — leaving a half-started stack and a
  // stack trace that named neither port.
  await sockets.ready;

  const ports: RoundPorts = {
    marketData: market,
    picks,
    // A local block hash. On chain this is a finalized block (§13.6), which is
    // what makes the tiebreak unpredictable in advance — a constant here would
    // make it predictable, and that is fine for a demo and fatal in production.
    chain: { finalizationBlockHash: () => Promise.resolve(`0x${'e1'.repeat(32)}`) },
    publisher: bus ?? sockets.gateway,
    store,
  };

  // The driver holds the round; this is how anything serving it reads it.
  let round: RoundEngineState | null = null;

  /**
   * An instance that is not driving still has to serve the round.
   *
   * §5 makes every instance a place to watch from, and the round is the
   * driver's — which on another instance means the store's. Read once a second:
   * the checkpoint is written at every transition (§25), so a follower is at
   * most a second behind on the phase, and not behind at all on the ticks,
   * which reach it through the bus.
   */
  const followStore = setInterval(() => {
    if (lease?.held === true) {
      return;
    }
    void store
      .loadLatest()
      .then((latest) => {
        if (latest !== null) {
          round = latest;
        }
      })
      .catch(() => undefined);
  }, 1_000);
  followStore.unref();

  const api = buildServer({
    // The Vite dev server, on both spellings of localhost — a browser treats
    // them as different origins, and which one a developer types is not
    // something to leave failing with a CORS error that names neither.
    allowedOrigins: WEB_ORIGINS,
    currentRound: () => round,
    // Read straight off the store the loop writes to. §25 makes a result
    // immutable once it exists, so there is nothing to cache and nothing that
    // could go stale — a second copy would only be a second thing to be wrong.
    finalizedResult: (battleId) =>
      database === null
        ? Promise.resolve(
            memoryStore.finalizations
              .flatMap((finalization) => finalization.results)
              .find((result) => result.battleId === battleId) ?? null,
          )
        : readFinalizedResult(database, battleId),
    // From the same finalizations, through the same derivation a deployment
    // uses — a record in the local stack follows the rules production does.
    playerRecords:
      database === null
        ? new MemoryPlayerRecords(() => memoryStore.finalizations)
        : new PostgresPlayerRecords(database),
    cards,
    picks,
    config: CONFIG,
    now,
    walletOf,
    auth,
  });

  try {
    await api.listen({ port: PORT_API, host: '127.0.0.1' });
  } catch (error) {
    // The socket server is accepting connections by now and would hold the
    // process open long after the failure, so it comes down with it.
    await sockets.close();
    throw error;
  }

  process.stdout.write(
    [
      '',
      'PonsWars local stack — development only.',
      '  The market is synthetic: generated prices, not a market (§102).',
      database === null
        ? '  The store is in memory. Set DATABASE_URL to run on PostgreSQL.'
        : '  The store is PostgreSQL, through the adapters the server uses.',
      '',
      `  API       http://127.0.0.1:${String(PORT_API)}/v1/rounds/current`,
      `  WebSocket ws://127.0.0.1:${String(PORT_WS)}`,
      '',
    ].join('\n'),
  );

  // One instance drives the rounds (§25). With Redis that is whoever holds the
  // lease; the others serve the API and fan out what the leader publishes,
  // which is what makes a second instance useful rather than dangerous.
  const stopping = new AbortController();
  lease =
    bus === null
      ? null
      : await takeLease({
          url: redisUrl ?? '',
          name: 'rounds',
          holder: `local-${String(process.pid)}`,
          ttlMs: LEASE_TTL_MS,
          signal: stopping.signal,
          onProblem: (problem) => {
            process.stdout.write(`${problem}\n`);
          },
        });
  if (bus !== null) {
    process.stdout.write(
      lease === null ? 'not driving rounds\n' : 'holding the rounds lease; driving\n',
    );
    // A lease lost mid-round stops this driver at once: after the expiry
    // another instance is entitled to drive, and two drivers is the thing the
    // lease exists to prevent.
    void lease?.lost.then(() => {
      stopping.abort();
    });
  }

  // The loop itself lives in `@ponswars/round-service`, because the deployable
  // server runs the same one. What is local about this stack is which ports it
  // hands over, not how a round is driven.
  try {
    await runRounds({
      signal: stopping.signal,
      ports,
      config: CONFIG,
      calibration: CONFIDENCE_CALIBRATION,
      now,
      tickMs: TICK_MS,
      baseSeedHex: `0x${'5c'.repeat(32)}`,
      onRound: (next) => {
        round = next;
      },
      onEvent: (event) => {
        process.stdout.write(describe(event));
      },
    });
  } finally {
    // The loop can fail rather than stop, and the API and the socket server
    // both hold the event loop open — so without this a stack whose round
    // loop had died stayed up, still answering with the last round it saw.
    // A process that exits is a process someone notices.
    clearInterval(followStore);
    await api.close();
    await sockets.close();
    await lease?.release();
    await bus?.close();
    await recovery?.close();
    await database?.close();
  }
}

/** One line of console for whatever the driver just did. */
function describe(event: DriverEvent): string {
  switch (event.kind) {
    case 'RESUMED':
      return `${event.round.roundId}  resumed from checkpoint (${event.round.state})\n`;
    case 'OPENED':
      return `\n${event.round.roundId}  opened\n`;
    case 'STATE':
      return `${event.round.roundId}  ${event.from} → ${event.round.state}\n`;
    case 'FINALIZED':
      return [
        ...event.finalization.results.map(
          (result) =>
            `  ${result.left} vs ${result.right} → ${result.winner} (${result.victoryLabel})\n`,
        ),
        ...event.finalization.voided.map((voided) => `  ${voided} → VOID\n`),
      ].join('');
    case 'MARKET_CLOSED':
      return `market closed — the next round opens ${new Date(event.reopensAt).toISOString()}\n`;
  }
}

/**
 * The port a listen error failed on, if that is what it was.
 *
 * Node reports a taken port as a `code` and a `port` on an otherwise ordinary
 * `Error`, and starting this stack while one is already running is the most
 * likely way to start it wrongly — so it is worth a sentence rather than a
 * stack trace that names neither port.
 */
function portInUse(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const { code, port } = error as { code?: unknown; port?: unknown };
  return code === 'EADDRINUSE' && typeof port === 'number' ? port : null;
}

main().catch((error: unknown) => {
  const taken = portInUse(error);
  process.stderr.write(
    taken === null
      ? `local stack failed: ${String(error)}\n`
      : [
          `local stack: port ${String(taken)} is already in use.`,
          '  Another stack is probably still running. Stop it, or set PORT_API',
          '  and PORT_WS to different ports.',
          '',
        ].join('\n'),
  );
  process.exitCode = 1;
});
