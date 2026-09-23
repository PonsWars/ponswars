import { assertChain, robinhoodChainRpc, rpcDistributorContract } from '@ponswars/chain';
import { baseUnits, utcTimestamp } from '@ponswars/shared-types';
import { DistributionError, PostgresDistributionStore } from '@ponswars/store-postgres';
import { DISTRIBUTION_USAGE, parseDistributionArgs } from './distribution-args.js';
import { privateKeyToAccount } from 'viem/accounts';
import { connectPostgres } from '@ponswars/postgres';
import { publishDistribution } from './publication.js';
import { writeSnapshot } from './snapshot-file.js';
import { chainSettings, publisherKey } from './chain-settings.js';

/**
 * Opens, snapshots, calculates and publishes distribution windows (§16, §17).
 *
 * A job in the same image as the server, beside `migrate.js`:
 *
 *   node dist/distribution.js open --id 42 --start 2026-09-14T00:00:00Z
 *   node dist/distribution.js snapshot --id 42 --pool-balance <base units> \
 *     --minimum-claim <base units> --out snapshot-42.json
 *   node dist/distribution.js calculate --id 42 --minimum-claim <base units>
 *   node dist/distribution.js publish --id 42 --expect-root 0x…
 *
 * The snapshot file is exactly what `tools/verify-distribution.mjs` recomputes
 * the allocation from, so the runbook's next step takes it as it is.
 *
 * ## Configuration
 *
 * `DATABASE_URL`, for the reason `migrate.js` gives: this is an operator step,
 * and it must not be blocked by a server setting nobody has decided yet.
 * `publish` also reads `RPC_URL`, `CHAIN_ID` and `REWARDS_DISTRIBUTOR_ADDRESS`,
 * and `DISTRIBUTION_PUBLISHER_KEY` when this job is to send the transaction
 * itself — without it, it records a root the publisher multisig already put on
 * chain.
 */

async function main(): Promise<void> {
  const parsed = parseDistributionArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.problem}\n\n${DISTRIBUTION_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const { command } = parsed;

  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    process.stderr.write('DATABASE_URL is not set.\n');
    process.exitCode = 2;
    return;
  }

  const database = connectPostgres({ connectionString: url, maxConnections: 1 });
  try {
    const store = new PostgresDistributionStore(database);

    if (command.kind === 'OPEN') {
      const { windowEnd } = await store.openWindow({
        distributionId: command.distributionId,
        windowStart: utcTimestamp(command.windowStart),
      });
      process.stdout.write(
        `opened distribution ${command.distributionId.toString()}: ` +
          `${new Date(command.windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}\n`,
      );
      return;
    }

    if (command.kind === 'CALCULATE') {
      const calculated = await store.calculate({
        distributionId: command.distributionId,
        minimumClaim: baseUnits(command.minimumClaim),
      });
      process.stdout.write(
        calculated.root === null
          ? `calculated distribution ${command.distributionId.toString()}: no wallet is above the minimum claim, so there is no root and the pool carries forward\n`
          : `calculated distribution ${command.distributionId.toString()}: ` +
              `${String(calculated.claimable)} claim(s), total ${calculated.total.toString()}\n` +
              `root ${calculated.root}\n` +
              `verify it before publishing:\n` +
              `  node tools/verify-distribution.mjs snapshot-${command.distributionId.toString()}.json --expect-root ${calculated.root}\n`,
      );
      return;
    }

    if (command.kind === 'PUBLISH') {
      const chain = { ...chainSettings(), publisherKey: publisherKey() };
      const rpc = robinhoodChainRpc(chain.url);
      await assertChain(rpc.chain, chain.chainId);
      const contract = rpcDistributorContract({
        url: chain.url,
        chainId: chain.chainId,
        distributor: chain.distributor,
        publisherKey: chain.publisherKey,
      });
      const outcome = await publishDistribution({
        store,
        contract,
        publisher:
          chain.publisherKey === null ? null : privateKeyToAccount(chain.publisherKey).address,
        distributionId: command.distributionId,
        expectRoot: command.expectRoot,
      });
      const { distribution } = outcome;
      process.stdout.write(
        `${outcome.kind === 'PUBLISHED' ? 'published' : outcome.kind === 'RECORDED' ? 'recorded the publication of' : 'already recorded'} ` +
          `distribution ${command.distributionId.toString()}: root ${String(distribution.root)}, ` +
          `total ${distribution.total.toString()}, transaction ${String(distribution.publicationTx)}\n`,
      );
      return;
    }

    // The order — claim the file, then take the snapshot, and leave no empty
    // file behind if it is refused — is `snapshot-file.ts`'s, shared with the
    // worker that does this on a schedule so the two cannot drift.
    const snapshot = await writeSnapshot({
      store,
      distributionId: command.distributionId,
      poolBalance: baseUnits(command.poolBalance),
      minimumClaim: command.minimumClaim,
      path: command.out,
    });

    process.stdout.write(
      `snapshotted distribution ${command.distributionId.toString()}: ` +
        `${String(snapshot.standings.length)} wallet(s), pool ${command.poolBalance.toString()}\n` +
        `wrote ${command.out} — verify it before calculating:\n` +
        `  node tools/verify-distribution.mjs ${command.out}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const refused = error instanceof DistributionError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${refused ? 'refused' : 'distribution job failed'}: ${message}\n`);
  process.exitCode = 1;
});
