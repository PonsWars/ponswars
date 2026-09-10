import { buildServer, PickStore } from '@ponswars/api';
import {
  CURRENT_ENGINE_VERSIONS,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import { RATIO_SCALE, type ConfidenceCalibration } from '@ponswars/battle-math';
import { ConfigError, loadConfig, type MarketDataProvider } from '@ponswars/config';
import { startSocketServer } from '@ponswars/gateway';
import { SyntheticMarket } from '@ponswars/market-data';
import {
  runRounds,
  type DriverEvent,
  type MarketDataPort,
  type RoundPorts,
} from '@ponswars/round-service';
import {
  milliseconds,
  utcTimestamp,
  walletAddress,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { PostgresRoundStore, readFinalizedResult } from '@ponswars/store-postgres';
import { connectPostgres } from './postgres.js';

/**
 * The deployable service (§21.3, §59.3, §65.2).
 *
 * One process: the round driver, the REST API and the realtime gateway, wired
 * from validated configuration. The local stack beside it composes the same
 * pieces with development stand-ins and says so on startup; this one takes
 * every deployment fact from the environment and refuses to start without one.
 *
 * ## What it refuses
 *
 * §65.2 requires startup to fail fast when configuration is missing or invalid,
 * and §102 forbids inventing an `OPEN` value and shipping it as policy. So
 * there are no defaults here: no fallback port, no default origin list, no
 * assumed market vendor. `loadConfig` reports every missing parameter at once —
 * one restart to learn what is wrong rather than one per parameter.
 *
 * ## What is still a stand-in, and says so
 *
 * The market. `MARKET_DATA_PROVIDER` has one member today, `synthetic`, and it
 * is not a market: choosing a vendor is a commercial and licensing decision
 * that has not been made. A deployment running it prints a line saying the
 * prices are not real, every time it starts, because the failure mode for a
 * thing like this is somebody running it and believing it.
 *
 * Authentication is the other. §45.2 puts wallet-signature verification in an
 * auth service that does not exist yet, so writes are attributed to a
 * configured wallet or refused entirely. It is refused entirely unless
 * `NODE_ENV` is `development`, because the alternative is a deployment where
 * any caller can pick on anyone's behalf.
 */

const now = (): UtcTimestamp => utcTimestamp(Date.now());

/**
 * Engine calibration.
 *
 * `OPEN` production tuning (§59.4) and these are *not* the production values —
 * they are the ones every test in this repository exercises. They are here
 * rather than in the environment because §59.4 covers the whole block as one
 * decision: a deployment that set half of it from variables would be a
 * calibration nobody had looked at as a whole. When someone decides, this moves
 * to the parameter table with the rest.
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

/** Confidence bands (§10.1). Measured against the synthetic market, like the above. */
const CONFIDENCE_CALIBRATION: ConfidenceCalibration = {
  priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
  volumePulse: { rising: 1_167_000n, weak: 1_033_000n },
  ponsActivity: { high: 40n, medium: 20n },
  momentumStability: { stable: 26, mixed: 32 },
  matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
};

/**
 * The market adapter this deployment was told to run.
 *
 * A `switch` over a closed union rather than a lookup, so adding a vendor to
 * the config type without writing its adapter fails to compile instead of
 * failing at three in the morning.
 */
function marketFor(provider: MarketDataProvider): { port: MarketDataPort; real: boolean } {
  // The union has one member today, so `no-unnecessary-condition` is right that
  // the comparison always holds. It is a switch anyway: the day a second vendor
  // is added to the config union, this function stops compiling and names the
  // adapter nobody wrote. That is the whole point of the shape.
  switch (provider) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    case 'synthetic':
      return { port: new SyntheticMarket(), real: false };
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const development = config.NODE_ENV === 'development';

  const market = marketFor(config.MARKET_DATA_PROVIDER);
  const database = connectPostgres({
    connectionString: config.DATABASE_URL,
    // The driver's writes and the API's reads share this process. Ten is room
    // for a burst of reads without the finalization transaction queueing behind
    // them, and small enough that a handful of instances do not exhaust a
    // managed instance's connection limit between them.
    maxConnections: 10,
  });
  const store = new PostgresRoundStore(database);
  const picks = new PickStore();

  /**
   * Who a request is from (§45.2).
   *
   * Signature verification belongs to the auth service and there is not one, so
   * outside development every write is refused rather than attributed to
   * somebody. A deployment where any caller can pick on anyone's behalf is
   * worse than one where nobody can pick at all.
   */
  const demoWallet: WalletAddress = walletAddress(`0x${'d'.repeat(40)}`);
  const walletOf = (authorization: string | undefined): WalletAddress | null =>
    development && authorization !== undefined ? demoWallet : null;

  const sockets = startSocketServer({ port: config.GATEWAY_PORT, now, walletOf });
  // Before anything else binds. A failed WebSocket bind surfaces a tick later
  // than the call that caused it, so without this the API port is already taken
  // by the time the process dies.
  await sockets.ready;

  const ports: RoundPorts = {
    marketData: market.port,
    picks,
    // §13.6: a finalized block hash is what makes the tiebreak unpredictable in
    // advance. There is no chain client yet — §59.3 leaves the RPC vendor open
    // — so this is the one port with no honest implementation, and it throws
    // rather than returning a constant. A predictable tiebreak is worse than a
    // failed finalization, which at least gets looked at.
    chain: {
      finalizationBlockHash: () =>
        Promise.reject(
          new Error(
            'No chain client configured. §13.6 needs a finalized block hash for the tiebreak; ' +
              'the RPC vendor is an OPEN decision (docs/OPEN_PARAMETERS.md §1).',
          ),
        ),
    },
    publisher: sockets.gateway,
    store,
  };

  let round: RoundEngineState | null = null;

  const api = buildServer({
    allowedOrigins: config.ALLOWED_ORIGINS,
    currentRound: () => round,
    // Straight off the table the driver's finalization wrote to (§25), rather
    // than from anything this process is holding. A result is immutable once it
    // exists, so there is nothing to cache — and a shared `/result/:battleId`
    // link has to answer after a restart, on an instance that never ran the
    // battle. Reading it from memory would have made both of those a 404.
    finalizedResult: (battleId) => readFinalizedResult(database, battleId),
    picks,
    config: CONFIG,
    now,
    walletOf,
  });

  try {
    // `0.0.0.0` rather than loopback: a container's port is published by
    // whatever runs it, and a service bound to loopback inside one is
    // unreachable from outside it.
    await api.listen({ port: config.API_PORT, host: '0.0.0.0' });
  } catch (error) {
    await sockets.close();
    await database.close();
    throw error;
  }

  say(banner(config.API_PORT, config.GATEWAY_PORT, config.MARKET_DATA_PROVIDER, market.real));

  /**
   * Stops between rounds rather than mid-write (§25).
   *
   * An orchestrator sends `SIGTERM` and then waits before `SIGKILL`. What must
   * not happen in that window is a finalization torn in half, so the driver is
   * asked to stop after the step it is in and everything else comes down after
   * it has.
   */
  const stopping = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    say(`\n${signal} — finishing the current step, then stopping\n`);
    stopping.abort();
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  try {
    await runRounds({
      ports,
      config: CONFIG,
      calibration: CONFIDENCE_CALIBRATION,
      now,
      tickMs: config.BATTLE_ENGINE_TICK_MS,
      // §26: per-deployment, and never generated here — a server that invented
      // one would make two deployments of the same code produce different
      // evidence for the same inputs.
      baseSeedHex: `0x${'5c'.repeat(32)}`,
      onRound: (next) => {
        round = next;
      },
      onEvent: (event) => {
        say(describe(event));
      },
      signal: stopping.signal,
    });
  } finally {
    // `finally`, not the happy path. The driver can fail rather than stop —
    // the chain port has no implementation and rejects (§13.6) — and without
    // this the process stayed up afterwards: the API kept the event loop
    // alive, so a service whose round loop had died went on answering
    // `/v1/ready` with `200` and serving the last round it saw, forever. A
    // crash an orchestrator can see is worth more than a process that is
    // technically still running.
    await api.close();
    await sockets.close();
    await database.close();
  }

  say('stopped cleanly\n');
}

function banner(
  apiPort: number,
  gatewayPort: number,
  provider: MarketDataProvider,
  real: boolean,
): string {
  return [
    '',
    'PonsWars server',
    `  API       :${String(apiPort)}   (health /v1/health, readiness /v1/ready)`,
    `  Gateway   :${String(gatewayPort)}`,
    `  Market    ${provider}`,
    ...(real
      ? []
      : [
          '',
          '  The market data is SYNTHETIC. These prices are generated, not',
          '  observed. Choosing a vendor is an OPEN decision (§102).',
        ]),
    '',
    '',
  ].join('\n');
}

/** One line of log for whatever the driver just did. */
function describe(event: DriverEvent): string {
  switch (event.kind) {
    case 'RESUMED':
      return `${event.round.roundId}  resumed from checkpoint (${event.round.state})\n`;
    case 'OPENED':
      return `${event.round.roundId}  opened\n`;
    case 'STATE':
      return `${event.round.roundId}  ${event.from} → ${event.round.state}\n`;
    case 'FINALIZED':
      return [
        ...event.finalization.results.map(
          (result) => `  ${result.left} vs ${result.right} → ${result.winner}\n`,
        ),
        ...event.finalization.voided.map((voided) => `  ${voided} → VOID\n`),
      ].join('');
  }
}

function say(line: string): void {
  process.stdout.write(line);
}

main().catch((error: unknown) => {
  // A configuration failure is the expected way to get this wrong and deserves
  // its own message: it already names every parameter that is missing or
  // invalid, and a stack trace on top of that buries the part worth reading.
  process.stderr.write(
    error instanceof ConfigError ? `${error.message}\n` : `server failed: ${String(error)}\n`,
  );
  process.exitCode = 1;
});
