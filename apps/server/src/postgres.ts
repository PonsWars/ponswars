import pg from 'pg';
import type { SqlDatabase, SqlExecutor } from '@ponswars/store-postgres';

/**
 * A `SqlDatabase` over `node-postgres` (§21.3, §59.3).
 *
 * `@ponswars/store-postgres` deliberately imports no driver — which client
 * library talks to PostgreSQL is a deployment detail, and a package that picked
 * one would be a decision about it. This is where the decision is made, in the
 * service that deploys, and it is about thirty lines because that is all the
 * seam is.
 *
 * PostgreSQL itself is not the open question. `database/migrations` is
 * PostgreSQL DDL; §59.3 leaves the managed *provider* open, which is a hosting
 * decision.
 */

/**
 * `BIGINT` comes back as a string by default, and every one of ours is a count
 * or a scaled integer that has to survive the trip exactly.
 *
 * `bigint` is what the engine works in (ADR 0003), so the parser hands one
 * back rather than a `number` that silently loses precision above 2^53. Set
 * once, at the driver, so no call site has to remember.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => BigInt(value));

export interface PostgresOptions {
  readonly connectionString: string;
  /**
   * How many connections this process may hold.
   *
   * One process runs the driver and serves the API, and the driver's writes are
   * what must not queue behind a burst of reads — §25's finalization is a
   * transaction with a deadline on it.
   */
  readonly maxConnections: number;
}

export interface PostgresHandle extends SqlDatabase {
  /** Closes the pool. Waits for in-flight statements rather than cutting them. */
  close(): Promise<void>;
}

export function connectPostgres(options: PostgresOptions): PostgresHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    // A connection that cannot be had is a failure to report, not something to
    // wait on forever: a request holding a handler open indefinitely is how a
    // database outage becomes an unresponsive service.
    connectionTimeoutMillis: 10_000,
  });

  return {
    async query(text, params) {
      const result = await pool.query(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows as Record<string, unknown>[] };
    },

    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const executor: SqlExecutor = {
          async query(text, params) {
            const result = await client.query(text, params === undefined ? undefined : [...params]);
            return { rows: result.rows as Record<string, unknown>[] };
          },
        };
        const value = await work(executor);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // Rolled back on the same connection the work ran on, and its own
        // failure is swallowed: the error worth reporting is the one that
        // caused the rollback, not whatever went wrong trying to undo it.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
