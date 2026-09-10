import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPostgres } from './postgres.js';

/**
 * Applies the schema (§21.3, §49).
 *
 * A second entrypoint in the same image as the server, run as a job before it:
 *
 *   node dist/migrate.js [directory]
 *
 * The image carries the migrations it expects, so the schema and the code that
 * reads it are one artifact. A deployment cannot apply the wrong version of the
 * schema for the binary it is running, because there is only one of each.
 *
 * ## What it will not do
 *
 * Re-run a file it has already applied, apply a file that has changed since it
 * was applied, or apply anything at all while another copy is applying. The
 * first is the whole point of a ledger; the second is the mistake that ledger
 * exists to catch — an edited migration is a schema two databases disagree
 * about; the third is what the advisory lock is for, because a rolling deploy
 * starts several of these at once.
 *
 * ## Configuration
 *
 * `DATABASE_URL` and nothing else. It deliberately does not go through
 * `@ponswars/config`: that contract is what the *server* needs to run a round —
 * a chain RPC, token addresses, feed staleness — and a job that only creates
 * tables should not be blocked by a reward token address nobody has decided
 * yet.
 */

/**
 * One lock for the whole ledger, held for the length of a run.
 *
 * An arbitrary constant, and it only has to be the same one everywhere: two
 * copies of this job starting together is the ordinary case in a rolling
 * deploy, and without this they would race to create the same table.
 */
const LOCK_KEY = 721_204_601;

interface Applied {
  readonly filename: string;
  readonly checksum: string;
}

/**
 * The body of a migration, with its own transaction control removed.
 *
 * Every migration wraps itself in `BEGIN`/`COMMIT` so that applying one by hand
 * with `psql` is atomic. Run from here it has to be atomic *with* the row that
 * records it — otherwise a crash in the gap leaves a schema that is applied and
 * a ledger that says it is not, and the next run tries again and fails on a
 * table that already exists.
 *
 * The shape is required rather than tolerated: a file that does not wrap itself
 * is refused by name, because the alternative is applying half of it.
 */
function body(filename: string, sql: string): string {
  const trimmed = sql.trim();
  if (!/^BEGIN;/m.test(trimmed) || !trimmed.endsWith('COMMIT;')) {
    throw new Error(
      `${filename}: a migration must begin with 'BEGIN;' on its own line and end with 'COMMIT;'.`,
    );
  }
  return trimmed.replace(/^BEGIN;$/m, '').slice(0, -'COMMIT;'.length);
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is required and was not set.');
  }

  // Beside the code, so the image carries its own schema. An argument overrides
  // it for running against a checkout, which is a path rather than a policy.
  const directory = process.argv[2] ?? fileURLToPath(new URL('../migrations/', import.meta.url));

  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`No migrations found in ${directory}`);
  }

  // One connection: the advisory lock is held by the session that took it, and
  // a pool could hand the unlock to a different one.
  const database = connectPostgres({ connectionString: url, maxConnections: 1 });

  try {
    await database.query(`SELECT pg_advisory_lock(${String(LOCK_KEY)})`);
    await database.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT        PRIMARY KEY,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await database.query('SELECT filename, checksum FROM schema_migrations');
    const already = new Map(
      (rows as unknown as Applied[]).map((row) => [row.filename, row.checksum]),
    );

    let applied = 0;
    for (const filename of files) {
      const sql = await readFile(join(directory, filename), 'utf8');
      const checksum = checksumOf(sql);
      const previous = already.get(filename);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `${filename} has changed since it was applied. A migration is a fact about a ` +
              'database that already exists; write a new one instead.',
          );
        }
        continue;
      }

      await database.transaction(async (tx) => {
        await tx.query(body(filename, sql));
        await tx.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ]);
      });
      process.stdout.write(`applied ${filename}\n`);
      applied += 1;
    }

    process.stdout.write(
      applied === 0
        ? `schema is up to date (${String(files.length)} migrations)\n`
        : `applied ${String(applied)} migration(s)\n`,
    );
  } finally {
    // Released explicitly rather than left to the disconnect, so the next job
    // does not wait on a socket timing out.
    await database.query(`SELECT pg_advisory_unlock(${String(LOCK_KEY)})`).catch(() => undefined);
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
