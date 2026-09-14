import { open, unlink } from 'node:fs/promises';
import { assertChain, robinhoodChainRpc, rpcDistributorContract } from '@ponswars/chain';
import { baseUnits, robinhoodChainNetwork, utcTimestamp } from '@ponswars/shared-types';
import { DistributionError, PostgresDistributionStore } from '@ponswars/store-postgres';
import { DISTRIBUTION_USAGE, parseDistributionArgs } from './distribution-args.js';
import { privateKeyToAccount } from 'viem/accounts';
import { connectPostgres } from './postgres.js';
import { publishDistribution } from './publication.js';

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
      const chain = chainSettings();
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

    // The file is claimed before the snapshot is taken, not after. A snapshot
    // commits and cannot be taken twice, so a file that failed to open
    // afterwards would leave the window snapshotted and its standings on no
    // disk. `wx` also refuses an existing file: two snapshot files under one
    // name is how the wrong one gets verified.
    const handle = await open(command.out, 'wx');
    let wallets: number;
    try {
      const snapshot = await store.snapshot({
        distributionId: command.distributionId,
        poolBalance: baseUnits(command.poolBalance),
      });
      wallets = snapshot.standings.length;
      const file = {
        distributionId: snapshot.distributionId.toString(),
        poolBalance: snapshot.poolBalance.toString(),
        minimumClaim: command.minimumClaim.toString(),
        standings: snapshot.standings,
      };
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`);
    } catch (error: unknown) {
      await handle.close();
      // The file is ours and empty: the snapshot was refused before anything
      // was written to it.
      await unlink(command.out);
      throw error;
    }
    await handle.close();

    process.stdout.write(
      `snapshotted distribution ${command.distributionId.toString()}: ` +
        `${String(wallets)} wallet(s), pool ${command.poolBalance.toString()}\n` +
        `wrote ${command.out} — verify it before calculating:\n` +
        `  node tools/verify-distribution.mjs ${command.out}\n`,
    );
  } finally {
    await database.close();
  }
}

/**
 * The chain a publication goes to, read from the environment and refused early.
 *
 * Only Robinhood Chain; an address that is an address; a publisher key that is
 * a key, or absent. The key is never echoed back.
 */
function chainSettings(): {
  readonly url: string;
  readonly chainId: number;
  readonly distributor: `0x${string}`;
  readonly publisherKey: `0x${string}` | null;
} {
  const url = process.env['RPC_URL'] ?? '';
  const chainId = Number(process.env['CHAIN_ID']);
  const distributor = process.env['REWARDS_DISTRIBUTOR_ADDRESS'] ?? '';
  const key = process.env['DISTRIBUTION_PUBLISHER_KEY'];
  if (!/^(https?|wss?):\/\//.test(url)) {
    throw new DistributionError('RPC_URL must be a Robinhood Chain JSON-RPC endpoint.');
  }
  if (robinhoodChainNetwork(chainId) === null) {
    throw new DistributionError('CHAIN_ID must be 4663 (Robinhood Chain) or 46630 (Testnet).');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(distributor)) {
    throw new DistributionError('REWARDS_DISTRIBUTOR_ADDRESS must be the distributor address.');
  }
  if (key !== undefined && key !== '' && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DistributionError('DISTRIBUTION_PUBLISHER_KEY must be a 32-byte private key.');
  }
  return {
    url,
    chainId,
    distributor: distributor.toLowerCase() as `0x${string}`,
    publisherKey: key === undefined || key === '' ? null : (key.toLowerCase() as `0x${string}`),
  };
}

main().catch((error: unknown) => {
  const refused = error instanceof DistributionError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${refused ? 'refused' : 'distribution job failed'}: ${message}\n`);
  process.exitCode = 1;
});
