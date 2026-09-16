import { assertChain, robinhoodChainRpc, rpcDistributorContract } from '@ponswars/chain';
import { baseUnits, robinhoodChainNetwork, utcTimestamp } from '@ponswars/shared-types';
import { DistributionError, PostgresDistributionStore } from '@ponswars/store-postgres';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { connectPostgres } from '@ponswars/postgres';
import { nextWindowStep } from './rewards-window.js';

/**
 * Keeps the rewards windows running on time (§16.2, §16.3).
 *
 * A job in the same image as the server, beside `migrate.js` and
 * `distribution.js`:
 *
 *   node dist/rewards-worker.js --snapshots /var/lib/ponswars/snapshots
 *
 * It does two of the four steps, the two with no judgement in them: it opens
 * each window where the last one ended, and snapshots it when its twenty-four
 * hours are up, reading the pool from the distributor's uncommitted balance.
 * It writes the snapshot file `tools/verify-distribution.mjs` recomputes from,
 * and stops there.
 *
 * It does not calculate and does not publish. Both have a human check in front
 * of them (`docs/operations/rewards-distribution.md`): the snapshot is
 * verified before it is calculated, the root before it is published. §17 makes
 * a published root immutable, and a scheduler that ran ahead would be
 * automating past the two steps that exist to be read by somebody.
 *
 * ## Configuration
 *
 * `DATABASE_URL`, `RPC_URL`, `CHAIN_ID`, `REWARDS_DISTRIBUTOR_ADDRESS`, and
 * `REWARDS_MINIMUM_CLAIM` — the minimum claim in base units, which goes into
 * the snapshot file so the operator calculates with the number the snapshot
 * was written under (§16.7). It is `OPEN`: this job records it, never invents
 * it, and refuses to start without it.
 */

/** How often the schedule is re-read when nothing is due sooner. */
const HEARTBEAT_MS = 60_000;

/** How long to wait before trying again after a failure. */
const RETRY_MS = 30_000;

async function main(): Promise<void> {
  const snapshots = snapshotDirectory();
  const settings = chainSettings();
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new DistributionError('DATABASE_URL is not set.');
  }

  const rpc = robinhoodChainRpc(settings.url);
  await assertChain(rpc.chain, settings.chainId);
  const distributor = rpcDistributorContract({
    url: settings.url,
    chainId: settings.chainId,
    distributor: settings.distributor,
    publisherKey: null,
  });

  const database = connectPostgres({ connectionString: url, maxConnections: 1 });
  const store = new PostgresDistributionStore(database);
  const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      say(`${signal} — stopping after the step in progress`);
      stopping.abort();
    });
  }

  say(`keeping rewards windows on time; snapshots to ${snapshots}`);
  try {
    while (!stopping.signal.aborted) {
      let sleepFor = HEARTBEAT_MS;
      try {
        const now = utcTimestamp(Date.now());
        const step = nextWindowStep(now, await store.latestWindow());
        if (step.kind === 'OPEN') {
          const { windowEnd } = await store.openWindow({
            distributionId: step.distributionId,
            windowStart: step.windowStart,
          });
          say(
            `opened distribution ${step.distributionId.toString()}: ` +
              `${new Date(step.windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`,
          );
        } else if (step.kind === 'SNAPSHOT') {
          await snapshot(store, distributor, step.distributionId, snapshots, settings.minimumClaim);
        } else {
          sleepFor = Math.min(HEARTBEAT_MS, Math.max(1_000, step.until - now));
        }
      } catch (error: unknown) {
        // A window is never half-taken: `snapshot` commits or refuses, and the
        // next pass reads the state that is actually there.
        say(`step failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        sleepFor = RETRY_MS;
      }
      await wait(sleepFor, stopping.signal);
    }
  } finally {
    await database.close();
  }
  say('stopped');
}

/**
 * Snapshots one window and writes the file the runbook verifies.
 *
 * The file is claimed before the snapshot is taken, as the operator command
 * does it: a snapshot commits and cannot be taken twice, so a file that could
 * not be opened afterwards would leave the standings on no disk.
 */
async function snapshot(
  store: PostgresDistributionStore,
  distributor: { uncommittedBalance(): Promise<bigint> },
  distributionId: bigint,
  directory: string,
  minimumClaim: bigint,
): Promise<void> {
  const poolBalance = await distributor.uncommittedBalance();
  const path = join(directory, `snapshot-${distributionId.toString()}.json`);
  const handle = await open(path, 'wx');
  try {
    const taken = await store.snapshot({ distributionId, poolBalance: baseUnits(poolBalance) });
    await handle.writeFile(
      `${JSON.stringify(
        {
          distributionId: taken.distributionId.toString(),
          poolBalance: taken.poolBalance.toString(),
          minimumClaim: minimumClaim.toString(),
          standings: taken.standings,
        },
        null,
        2,
      )}\n`,
    );
    say(
      `snapshotted distribution ${distributionId.toString()}: ` +
        `${String(taken.standings.length)} wallet(s), pool ${poolBalance.toString()}`,
    );
    say(`wrote ${path} — verify it, then calculate and publish (rewards-distribution.md)`);
  } finally {
    await handle.close();
  }
}

function snapshotDirectory(): string {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--snapshots');
  const value = flag === -1 ? undefined : args[flag + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new DistributionError(
      'Usage: node dist/rewards-worker.js --snapshots <directory>\n' +
        'It holds one snapshot file per window, verified before the window is calculated.',
    );
  }
  return value;
}

/** The chain this reads the pool from, and the minimum claim it records. */
function chainSettings(): {
  readonly url: string;
  readonly chainId: number;
  readonly distributor: `0x${string}`;
  readonly minimumClaim: bigint;
} {
  const url = process.env['RPC_URL'] ?? '';
  const chainId = Number(process.env['CHAIN_ID']);
  const distributor = process.env['REWARDS_DISTRIBUTOR_ADDRESS'] ?? '';
  const minimum = process.env['REWARDS_MINIMUM_CLAIM'] ?? '';
  if (!/^(https?|wss?):\/\//.test(url)) {
    throw new DistributionError('RPC_URL must be a Robinhood Chain JSON-RPC endpoint.');
  }
  if (robinhoodChainNetwork(chainId) === null) {
    throw new DistributionError('CHAIN_ID must be 4663 (Robinhood Chain) or 46630 (Testnet).');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(distributor)) {
    throw new DistributionError('REWARDS_DISTRIBUTOR_ADDRESS must be the distributor address.');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(minimum)) {
    throw new DistributionError(
      'REWARDS_MINIMUM_CLAIM must be the minimum claim in base units (§16.7). ' +
        'It is an OPEN decision; this job records it in every snapshot rather than inventing one.',
    );
  }
  return {
    url,
    chainId,
    distributor: distributor.toLowerCase() as `0x${string}`,
    minimumClaim: BigInt(minimum),
  };
}

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString()}  ${line}\n`);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

main().catch((error: unknown) => {
  const refused = error instanceof DistributionError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${refused ? 'refused' : 'rewards worker failed'}: ${message}\n`);
  process.exitCode = 1;
});
