/**
 * What an operator asked the distribution job to do (§16.2, §16.3).
 *
 * Parsed on its own so a mistyped command is refused before anything connects
 * to a database — a snapshot is the step §16 cannot undo, and the job should
 * never get as far as the ledger on a guess about what an argument meant.
 */

export const DISTRIBUTION_USAGE = `Usage:
  node dist/distribution.js open --id <n> --start <ISO-8601 instant>
  node dist/distribution.js snapshot --id <n> --pool-balance <base units> --minimum-claim <base units> --out <file>`;

export type DistributionCommand =
  | { readonly kind: 'OPEN'; readonly distributionId: bigint; readonly windowStart: number }
  | {
      readonly kind: 'SNAPSHOT';
      readonly distributionId: bigint;
      readonly poolBalance: bigint;
      readonly minimumClaim: bigint;
      readonly out: string;
    };

export type Parsed =
  | { readonly ok: true; readonly command: DistributionCommand }
  | { readonly ok: false; readonly problem: string };

export function parseDistributionArgs(args: readonly string[]): Parsed {
  const [verb, ...rest] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag?.startsWith('--') !== true) {
      return { ok: false, problem: `Expected a --flag, got ${String(flag)}.` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, problem: `${flag} needs a value.` };
    }
    if (flags.has(flag)) {
      return { ok: false, problem: `${flag} was given twice.` };
    }
    flags.set(flag, value);
  }

  const allowed =
    verb === 'open'
      ? ['--id', '--start']
      : verb === 'snapshot'
        ? ['--id', '--pool-balance', '--minimum-claim', '--out']
        : null;
  if (allowed === null) {
    return { ok: false, problem: `Unknown command ${String(verb)}.` };
  }
  for (const flag of flags.keys()) {
    if (!allowed.includes(flag)) {
      return { ok: false, problem: `${flag} is not an option of ${String(verb)}.` };
    }
  }
  for (const flag of allowed) {
    if (!flags.has(flag)) {
      return { ok: false, problem: `${String(verb)} needs ${flag}.` };
    }
  }

  const id = integer(flags.get('--id'));
  if (id === null) {
    return { ok: false, problem: '--id must be a non-negative integer.' };
  }

  if (verb === 'open') {
    const start = instant(flags.get('--start'));
    if (start === null) {
      return {
        ok: false,
        problem: '--start must be an ISO-8601 instant with a timezone, e.g. 2026-09-14T00:00:00Z.',
      };
    }
    return { ok: true, command: { kind: 'OPEN', distributionId: id, windowStart: start } };
  }

  const poolBalance = integer(flags.get('--pool-balance'));
  const minimumClaim = integer(flags.get('--minimum-claim'));
  if (poolBalance === null || minimumClaim === null) {
    return {
      ok: false,
      problem:
        '--pool-balance and --minimum-claim are base units: non-negative whole numbers, no decimal point.',
    };
  }
  return {
    ok: true,
    command: {
      kind: 'SNAPSHOT',
      distributionId: id,
      poolBalance,
      minimumClaim,
      out: flags.get('--out') ?? '',
    },
  };
}

/** A non-negative whole number of arbitrary size, or `null`. */
function integer(value: string | undefined): bigint | null {
  return value !== undefined && /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * An instant, only with its timezone written out.
 *
 * `2026-09-14T00:00` without a zone is midnight wherever the operator's shell
 * happens to be, and a window opened in the wrong timezone is a window a whole
 * day of players is shifted into.
 */
function instant(value: string | undefined): number | null {
  if (value === undefined || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
