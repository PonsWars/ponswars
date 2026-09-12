import { open, unlink } from 'node:fs/promises';
import { baseUnits, utcTimestamp } from '@ponswars/shared-types';
import { DistributionError, PostgresDistributionStore } from '@ponswars/store-postgres';
import { DISTRIBUTION_USAGE, parseDistributionArgs } from './distribution-args.js';
import { connectPostgres } from './postgres.js';

/**
 * Opens a distribution window, or snapshots one (§16.2, §16.3).
 *
 * A job in the same image as the server, beside `migrate.js`:
 *
 *   node dist/distribution.js open --id 42 --start 2026-09-14T00:00:00Z
 *   node dist/distribution.js snapshot --id 42 --pool-balance <base units> \
 *     --minimum-claim <base units> --out snapshot-42.json
 *
 * The snapshot file is exactly what `tools/verify-distribution.mjs` recomputes
 * the allocation from, so the runbook's next step takes it as it is.
 *
 * ## Configuration
 *
 * `DATABASE_URL` and nothing else, for the reason `migrate.js` gives: this is an
 * operator step, and it must not be blocked by a server setting nobody has
 * decided yet.
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

main().catch((error: unknown) => {
  const refused = error instanceof DistributionError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${refused ? 'refused' : 'distribution job failed'}: ${message}\n`);
  process.exitCode = 1;
});
