/**
 * The narrowest thing this adapter needs from a database client.
 *
 * Two methods, no driver. Which client library talks to PostgreSQL — `pg`,
 * `postgres.js`, a pooler's own — is a deployment detail, and importing one
 * here would make this package a decision about it. Both of the obvious
 * candidates satisfy this in a handful of lines.
 *
 * PostgreSQL itself is *not* an open question: `database/migrations` is
 * PostgreSQL DDL with PostgreSQL-specific enums, partial indexes and check
 * constraints. `docs/OPEN_PARAMETERS.md` leaves the managed *provider* open,
 * which is a hosting decision, not a schema one.
 */

/** One row, as a driver hands it back. */
export type SqlRow = Record<string, unknown>;

export interface SqlExecutor {
  /**
   * Runs one statement with positional parameters.
   *
   * Parameters, never interpolation. Every value that reaches this adapter came
   * from a wallet, a ticker or a client request id at some point, and a query
   * built by concatenation is the one place that stops being true.
   */
  query(text: string, params?: readonly unknown[]): Promise<{ readonly rows: SqlRow[] }>;
}

export interface SqlDatabase extends SqlExecutor {
  /**
   * Runs `work` inside one transaction, rolling back if it throws.
   *
   * Required rather than optional because §25 makes finalization exactly-once:
   * a result written without its War Points, or War Points without their
   * result, is a round that is partly finished — and a crash between two
   * statements is exactly when that happens.
   */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
