import { assertChain, robinhoodChainRpc, rpcDistributorContract } from '@ponswars/chain';
import { baseUnits, robinhoodChainNetwork, utcTimestamp } from '@ponswars/shared-types';
import { DistributionError, PostgresDistributionStore } from '@ponswars/store-postgres';
import { join } from 'node:path';
import { connectPostgres } from '@ponswars/postgres';
import { parseAlertWebhook } from '@ponswars/config';
import { alertSink, type AlertSink } from './alert-sink.js';
import { lateSnapshot, lifecycle, reconcile, type Condition } from './alerts.js';
import { nextWindowStep } from './rewards-window.js';
import { writeSnapshot, type SnapshotStore } from './snapshot-file.js';

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
 *
 * And `ALERT_WEBHOOK`, read by the same rule as the server's (§59.3). The
 * worker alerts when it starts, when it fails, and when a snapshot is due and
 * cannot be taken — the one moment in its day that cannot quietly wait.
 */

/** How often the schedule is re-read when nothing is due sooner. */
const HEARTBEAT_MS = 60_000;

/** How long to wait before trying again after a failure. */
const RETRY_MS = 30_000;

/** How long a failing worker waits for its last alert to go out. */
const FINAL_ALERT_WAIT_MS = 12_000;

/** What this process is called in an alert, so it never reads as the server. */
const NAME = 'Rewards worker';

/** The alert sink, module-level so the worker's own failure can be reported. */
let alerting: AlertSink | null = null;

async function main(): Promise<void> {
  const snapshots = snapshotDirectory();
  const settings = chainSettings();
  const webhook = parseAlertWebhook(process.env['ALERT_WEBHOOK'] ?? '');
  if (!webhook.ok) {
    // The parser's reason, never the value: the URL is the secret.
    throw new DistributionError(`ALERT_WEBHOOK: ${webhook.error}.`);
  }
  // The sink writes whole lines; this log adds its own timestamp and newline.
  const alerts = alertSink(webhook.value, {
    say: (line) => {
      say(line.trimEnd());
    },
    now: () => Date.now(),
  });
  alerting = alerts;
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
  alerts.send(lifecycle('STARTED', `Snapshots to ${snapshots}.`, NAME));

  // The window whose snapshot is due and has not been taken, if there is one.
  // Kept across passes, so a pass that fails before it can even read the
  // schedule still knows a snapshot was already late.
  let due: bigint | null = null;
  let reported: ReadonlyMap<string, Condition> = new Map();
  try {
    while (!stopping.signal.aborted) {
      let sleepFor = HEARTBEAT_MS;
      try {
        const now = utcTimestamp(Date.now());
        const step = nextWindowStep(now, await store.latestWindow());
        due = step.kind === 'SNAPSHOT' ? step.distributionId : null;
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
          await takeSnapshot(
            store,
            distributor,
            step.distributionId,
            snapshots,
            settings.minimumClaim,
          );
          due = null;
        } else {
          sleepFor = Math.min(HEARTBEAT_MS, Math.max(1_000, step.until - now));
        }
      } catch (error: unknown) {
        // A window is never half-taken: `snapshot` commits or refuses, and the
        // next pass reads the state that is actually there.
        say(`step failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        sleepFor = RETRY_MS;
      }
      // Late only while a snapshot is due and still not taken; it clears the
      // pass that takes it.
      const next = reconcile(reported, due === null ? [] : [lateSnapshot(due)]);
      reported = next.active;
      for (const message of next.messages) {
        alerts.send(message);
      }
      await wait(sleepFor, stopping.signal);
    }
  } finally {
    await database.close();
    await alerts.drained();
  }
  say('stopped');
}

/**
 * Snapshots one window and writes the file the runbook verifies.
 *
 * The file and the order it is written in are `snapshot-file.ts`'s, shared
 * with the operator command so the two cannot drift again.
 */
async function takeSnapshot(
  store: SnapshotStore,
  distributor: { uncommittedBalance(): Promise<bigint> },
  distributionId: bigint,
  directory: string,
  minimumClaim: bigint,
): Promise<void> {
  const poolBalance = await distributor.uncommittedBalance();
  const path = join(directory, `snapshot-${distributionId.toString()}.json`);
  const taken = await writeSnapshot({
    store,
    distributionId,
    poolBalance: baseUnits(poolBalance),
    minimumClaim,
    path,
  });
  say(
    `snapshotted distribution ${distributionId.toString()}: ` +
      `${String(taken.standings.length)} wallet(s), pool ${poolBalance.toString()}`,
  );
  say(`wrote ${path} — verify it, then calculate and publish (rewards-distribution.md)`);
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

main().catch(async (error: unknown) => {
  const refused = error instanceof DistributionError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${refused ? 'refused' : 'rewards worker failed'}: ${message}\n`);
  process.exitCode = 1;

  // Its kind and nothing else: an RPC error can carry the endpoint URL, which
  // is a secret (§87). The log has the rest.
  if (alerting !== null) {
    const kind = error instanceof Error ? error.name : 'unknown error';
    alerting.send(lifecycle('FAILED', `${kind}. The worker log has the detail.`, NAME));
    await Promise.race([
      alerting.drained(),
      new Promise((resolve) => setTimeout(resolve, FINAL_ALERT_WAIT_MS).unref()),
    ]);
  }
});
