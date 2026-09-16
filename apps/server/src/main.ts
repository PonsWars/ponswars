import { bearer, buildServer } from '@ponswars/api';
import { AuthService, workerRecovery } from '@ponswars/auth';
import {
  assertChain,
  assertReserver,
  assertTokenDecimals,
  ChainSecretVault,
  finalizedBlockAt,
  rpcDistributorContract,
  reserverVault,
  RpcChainPort,
  robinhoodChainRpc,
  secretVaultReader,
} from '@ponswars/chain';
import { GenesisFlow } from '@ponswars/genesis-service';
import type { RoundEngineState } from '@ponswars/battle-engine';
import { ConfigError, loadConfig, type MarketDataProvider } from '@ponswars/config';
import { startSocketServer } from '@ponswars/gateway';
import { runRounds, type DriverEvent, type RoundPorts } from '@ponswars/round-service';
import {
  baseUnits,
  chainLabel,
  parseDecimalToBaseUnits,
  SECRET_REWARD_SPY_DECIMAL,
  tokenDecimals,
  utcTimestamp,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import {
  PostgresAuthStore,
  PostgresCardHoldings,
  PostgresClaimStore,
  PostgresDistributionStore,
  PostgresGenesisStore,
  PostgresPickStore,
  PostgresPlayerRecords,
  PostgresRoundStore,
  readFinalizedResult,
} from '@ponswars/store-postgres';
import { loadEngineCalibration } from './calibration.js';
import { followClaims } from './claims.js';
import { startMarket, type RunningMarket } from './market.js';
import { connectPostgres } from '@ponswars/postgres';

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
 * ## The market, and the stand-in for it
 *
 * `MARKET_DATA_PROVIDER=onchain` reads the Stock Tokens' own trading on
 * Robinhood Chain, checked against their Chainlink feeds (§23.7), and opens a
 * round only where one fits inside US market hours (§23.8). It backfills
 * before the first round, so the API and gateway bind first: a health check
 * answers during the backfill and readiness says the service is starting.
 *
 * `synthetic` is not a market. A deployment running it prints a line saying
 * the prices are not real, every time it starts, because the failure mode for
 * a thing like this is somebody running it and believing it.
 *
 * Authentication used to be the other one. It is real now (§45.2): a wallet
 * signs a challenge, the signature is verified, and the session that comes back
 * lives in the database so that it survives a deploy and can be revoked.
 */

const now = (): UtcTimestamp => utcTimestamp(Date.now());

/**
 * How often a finalization waiting on its tiebreak block asks the chain again.
 *
 * Robinhood Chain finalizes in batches minutes apart, so asking every second
 * would spend RPC calls learning nothing; fifteen seconds adds at most that to
 * a wait already measured in minutes. A constant with a reason, not an `OPEN`
 * value (§102): no result depends on it, only how soon one is published.
 */
const TIEBREAK_POLL_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // How battles score and read, as one file (§59.4). Read before anything
  // binds: a service that started and then found it had no calibration would
  // have opened a round it could not score.
  const { engine: CONFIG, confidence: CONFIDENCE_CALIBRATION } = await loadEngineCalibration(
    config.ENGINE_CALIBRATION_FILE,
  );

  // Before anything connects or binds. An RPC endpoint on another network
  // would break ties from blocks on a chain PonsWars does not run on, and
  // nothing about the hashes it returned would look wrong.
  const rpc = robinhoodChainRpc(config.RPC_URL);
  const chain = rpc.chain;
  await assertChain(chain, config.CHAIN_ID);

  // The same reasoning for the two tokens: a decimals value off by one power
  // of ten converts every amount wrongly and nothing downstream looks wrong.
  const war = rpc.token(config.WAR_TOKEN_ADDRESS);
  await assertTokenDecimals(war, {
    parameter: 'WAR_TOKEN_DECIMALS',
    decimals: config.WAR_TOKEN_DECIMALS,
    chainId: config.CHAIN_ID,
  });
  await assertTokenDecimals(rpc.token(config.SPY_TOKEN_ADDRESS), {
    parameter: 'SPY_TOKEN_DECIMALS',
    decimals: config.SPY_TOKEN_DECIMALS,
    chainId: config.CHAIN_ID,
  });

  // §8.4: a Secret is revealed only once its reward is reserved, and only a
  // key holding RESERVER_ROLE can reserve. A deployment names that key or says
  // `disabled`; a key the vault has not granted the role is refused here, since
  // it would hold back every Secret while looking configured.
  let secretVault: ChainSecretVault | null = null;
  if (config.SECRET_RESERVER_KEY.kind === 'KEY') {
    const { contract, reserver } = reserverVault({
      url: config.RPC_URL,
      chainId: config.CHAIN_ID,
      vault: config.SECRET_STOCK_VAULT_ADDRESS,
      privateKey: config.SECRET_RESERVER_KEY.privateKey,
    });
    await assertReserver(contract, reserver, config.CHAIN_ID);
    secretVault = new ChainSecretVault(contract);
  }

  // §8.5: a winner claims their own reward, from their own wallet. The service
  // only reads what the vault owes them — no key involved, so this is here
  // whether or not a reserver is configured. The amount is the vault's own,
  // checked against the locked 0.2 SPY: a vault paying anything else is not
  // the vault this game promises (§8.1).
  const vaultReader = secretVaultReader({
    url: config.RPC_URL,
    chainId: config.CHAIN_ID,
    vault: config.SECRET_STOCK_VAULT_ADDRESS,
  });
  const secretReward = await vaultReader.rewardAmount();
  const lockedReward = parseDecimalToBaseUnits(
    SECRET_REWARD_SPY_DECIMAL,
    tokenDecimals(config.SPY_TOKEN_DECIMALS),
  );
  if (secretReward !== lockedReward) {
    throw new Error(
      `The Secret Stock Vault at ${config.SECRET_STOCK_VAULT_ADDRESS} pays ${secretReward.toString()} ` +
        `base units, and §8.1 locks the Secret reward at ${SECRET_REWARD_SPY_DECIMAL} SPY ` +
        `(${lockedReward.toString()}). Check SPY_TOKEN_DECIMALS and SECRET_STOCK_VAULT_ADDRESS.`,
    );
  }

  /**
   * Stops between rounds rather than mid-write (§25).
   *
   * An orchestrator sends `SIGTERM` and then waits before `SIGKILL`. What must
   * not happen in that window is a finalization torn in half, so the driver is
   * asked to stop after the step it is in and everything else comes down after
   * it has. A finalization still waiting for its tiebreak block stops waiting:
   * nothing was written, and the next start asks for the same block.
   */
  const stopping = new AbortController();

  const database = connectPostgres({
    connectionString: config.DATABASE_URL,
    // The driver's writes and the API's reads share this process. Ten is room
    // for a burst of reads without the finalization transaction queueing behind
    // them, and small enough that a handful of instances do not exhaust a
    // managed instance's connection limit between them.
    maxConnections: 10,
  });
  const store = new PostgresRoundStore(database);
  // In the database, beside the round they belong to. They were in this
  // process's memory, so a restart during Pick Phase lost every pick of the
  // round while each player who made one had been told it was recorded.
  const picks = new PostgresPickStore(database);

  /**
   * Who a request is from (§45.2).
   *
   * A wallet signature, verified, exchanged for a session that lives in the
   * database beside everything else. Sessions are there rather than in this
   * process for two reasons that are really one: a deploy must not sign
   * everybody out, and a session must be revocable — neither is possible for a
   * credential a single process settles on its own.
   */
  // Sign-in is the one request limited by arithmetic: recovering a signer runs
  // a few hundred times a second on one core, and everybody who opens the app
  // at a round boundary signs in within the same minute (§3.1). Spread over the
  // cores this process already has; `null` where there is only one.
  const recovery = workerRecovery();
  if (recovery !== null) {
    say(`sign-in signatures verify on ${String(recovery.threads)} threads
`);
  }

  const auth = new AuthService({
    store: new PostgresAuthStore(database),
    ...(recovery === null ? {} : { recover: recovery.recover }),
    policy: {
      challengeTtlMs: config.AUTH_CHALLENGE_TTL_MS,
      sessionTtlMs: config.AUTH_SESSION_TTL_MS,
      // The message names a host and a signature is bound to it, so this is the
      // client's origin rather than the API's — and the host without the
      // scheme, which is what EIP-4361 asks for.
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

  const sockets = startSocketServer({ port: config.GATEWAY_PORT, now, walletOf });
  // Before anything else binds. A failed WebSocket bind surfaces a tick later
  // than the call that caused it, so without this the API port is already taken
  // by the time the process dies.
  await sockets.ready;

  const distributions = new PostgresDistributionStore(database);
  const claims = new PostgresClaimStore(database);
  const distributor = rpcDistributorContract({
    url: config.RPC_URL,
    chainId: config.CHAIN_ID,
    distributor: config.REWARDS_DISTRIBUTOR_ADDRESS,
    publisherKey: null,
  });

  let waitingFor: UtcTimestamp | null = null;
  // Everything but the market, which is only ready once its backfill is.
  const ports: Omit<RoundPorts, 'marketData'> = {
    picks,
    // §12.7: the first Robinhood Chain block at or after the cutoff, once it is
    // finalized, is what makes the last tiebreak step unpredictable in advance
    // and checkable afterwards. The loop only asks when a battle is level
    // through every market component, so every other round finalizes without
    // touching the chain; a dead heat finalizes once its block is final.
    chain: new RpcChainPort(chain, {
      pollIntervalMs: TIEBREAK_POLL_MS,
      signal: stopping.signal,
      onWait: (cutoff) => {
        if (waitingFor !== cutoff) {
          waitingFor = cutoff;
          say(
            `a battle is tied through every market component; waiting for the first ` +
              `Robinhood Chain block after ${new Date(cutoff).toISOString()} to be finalized\n`,
          );
        }
      },
      onRetry: (_cutoff, error) => {
        say(`tiebreak block read failed, retrying: ${String(error)}\n`);
      },
    }),
    publisher: sockets.gateway,
    store,
  };

  let round: RoundEngineState | null = null;

  // Started once the API is listening; `null` through the backfill.
  let market: RunningMarket | null = null;

  const api = buildServer({
    allowedOrigins: config.ALLOWED_ORIGINS,
    currentRound: () => round,
    // The driver's own rule for when a round may open, so a client is told the
    // next round opens when the driver will actually open it.
    roundsOpenAt: (at) => market?.roundsOpenAt?.(at) ?? at,
    // Straight off the table the driver's finalization wrote to (§25), rather
    // than from anything this process is holding. A result is immutable once it
    // exists, so there is nothing to cache — and a shared `/result/:battleId`
    // link has to answer after a restart, on an instance that never ran the
    // battle. Reading it from memory would have made both of those a 404.
    finalizedResult: (battleId) => readFinalizedResult(database, battleId),
    // Derived from the ledgers finalization wrote, on every request (§49.2).
    playerRecords: new PostgresPlayerRecords(database),
    // From the cards table. Until Genesis claims are recorded from the chain it
    // is empty, and no wallet can arm a card it has not been shown to hold.
    cards: new PostgresCardHoldings(database),
    // §34.1: the wallet's $WAR, read from Robinhood Chain when its profile is
    // asked for. The decimals are the configured ones, which startup has
    // already checked against the token.
    warBalanceOf: async (wallet) => ({
      balance: await war.balanceOf(wallet),
      decimals: config.WAR_TOKEN_DECIMALS,
    }),
    // §16.8, §17: published rewards, claimed by the player's own wallet from the
    // distributor. Reads only — this process holds no key for it.
    rewardClaims: {
      chainId: config.CHAIN_ID,
      distributor: config.REWARDS_DISTRIBUTOR_ADDRESS,
      decimals: config.SPY_TOKEN_DECIMALS,
      claimsOf: (wallet) => distributions.publishedClaims(wallet),
      // The record first, the contract second. A claim this service has read
      // back is a claim; anything it has not read yet is asked of the chain,
      // so a reward claimed a second ago does not read as unclaimed while the
      // reader catches up.
      hasClaimed: async (distributionId, wallet) =>
        (await claims.claimedBy(wallet)).has(distributionId.toString()) ||
        (await distributor.hasClaimed(distributionId, wallet)),
    },
    // §6, §9: a Genesis card, dealt from the finalized hash of a Robinhood Chain
    // block chosen before it existed, and recorded with its card in PostgreSQL.
    genesis: new GenesisFlow({
      repository: new PostgresGenesisStore(database),
      chain: {
        headBlock: async () => Number(await chain.latestBlockNumber()),
        finalizedBlock: async (number) => {
          const block = await finalizedBlockAt(chain, BigInt(number));
          return block === null ? null : { number: Number(block.number), hash: block.hash };
        },
      },
      warBalanceOf: async (wallet) => baseUnits(await war.balanceOf(wallet)),
      warDecimals: tokenDecimals(config.WAR_TOKEN_DECIMALS),
      // Without a reserver the Secret band deals Legendary (§8.3), the rarity
      // table records that it did, and no player is shown a Secret they could
      // not be paid.
      secretVault,
      now,
    }),
    secretClaim: {
      chainId: config.CHAIN_ID,
      vault: config.SECRET_STOCK_VAULT_ADDRESS,
      decimals: config.SPY_TOKEN_DECIMALS,
      amount: secretReward,
      entitlementOf: (wallet) => vaultReader.entitlementOf(wallet),
    },
    picks,
    config: CONFIG,
    now,
    walletOf,
    auth,
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

  say(
    banner(
      config.API_PORT,
      config.GATEWAY_PORT,
      config.CHAIN_ID,
      secretVault !== null,
      config.MARKET_DATA_PROVIDER,
    ),
  );

  /**
   * Housekeeping for the auth tables.
   *
   * Expired challenges and sessions are already refused by every read — this is
   * about the tables not growing forever, which is why the interval is not
   * configuration: nothing behaves differently if a dead row survives another
   * hour. It is a constant with a reason rather than an `OPEN` value (§102).
   *
   * `unref` so it never holds the process open, and it swallows its own
   * failures: a database blip during a cleanup is not worth taking a service
   * down for, and the next hour will try again.
   */
  const housekeeping = setInterval(
    () => {
      void auth.prune().catch(() => undefined);
    },
    60 * 60 * 1_000,
  );
  housekeeping.unref();

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

  // Reading claims back from the chain runs beside the rounds: nothing waits
  // on it, and a claims page reads the contract itself when it has to (§17).
  const readingClaims = followClaims({
    store: claims,
    request: rpc.request,
    headBlock: () => chain.latestBlockNumber(),
    distributor: config.REWARDS_DISTRIBUTOR_ADDRESS,
    signal: stopping.signal,
    say,
  });

  try {
    try {
      market = await startMarket(config, stopping.signal, say);
    } catch (error) {
      // Stopped during the backfill: nothing was written, so nothing to finish.
      if (!stopping.signal.aborted) {
        throw error;
      }
    }
    if (market !== null) {
      await runRounds({
        ports: { ...ports, marketData: market.port },
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
        ...(market.roundsOpenAt === undefined ? {} : { roundsOpenAt: market.roundsOpenAt }),
        signal: stopping.signal,
      });
    }
  } finally {
    clearInterval(housekeeping);
    // `finally`, not the happy path. The driver can fail rather than stop — a
    // store write that fails, or a stop signal during a tiebreak wait — and without
    // this the process stayed up afterwards: the API kept the event loop
    // alive, so a service whose round loop had died went on answering
    // `/v1/ready` with `200` and serving the last round it saw, forever. A
    // crash an orchestrator can see is worth more than a process that is
    // technically still running.
    // The market stops following the chain whether the driver stopped or failed.
    stopping.abort();
    await market?.stopped;
    await readingClaims;
    await api.close();
    await sockets.close();
    await recovery?.close();
    await database.close();
  }

  say('stopped cleanly\n');
}

function banner(
  apiPort: number,
  gatewayPort: number,
  chainId: number,
  secret: boolean,
  provider: MarketDataProvider,
): string {
  return [
    '',
    'PonsWars server',
    `  API       :${String(apiPort)}   (health /v1/health, readiness /v1/ready)`,
    `  Gateway   :${String(gatewayPort)}`,
    `  Chain     ${chainLabel(chainId)}`,
    `  Secret    ${secret ? 'on — rewards reserved before reveal' : 'off — its band deals Legendary'}`,
    `  Market    ${provider === 'onchain' ? 'onchain — Stock Token trading on Robinhood Chain' : provider}`,
    ...(provider === 'synthetic'
      ? [
          '',
          '  The market data is SYNTHETIC. These prices are generated, not',
          '  observed. Run MARKET_DATA_PROVIDER=onchain for real battles.',
        ]
      : []),
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
    case 'MARKET_CLOSED':
      return `market closed — the next round opens ${new Date(event.reopensAt).toISOString()}\n`;
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
