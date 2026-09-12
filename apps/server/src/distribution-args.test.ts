import { describe, expect, it } from 'vitest';
import { parseDistributionArgs } from './distribution-args.js';

/** The refusal a command line gets, or `null` when it parses. */
function problemOf(args: readonly string[]): string | null {
  const parsed = parseDistributionArgs(args);
  return parsed.ok ? null : parsed.problem;
}

/**
 * The distribution job's command line.
 *
 * A snapshot cannot be undone, so every way of asking for one ambiguously is
 * refused here, before the job connects to anything.
 */

describe('opening a window', () => {
  it('reads an id and a start instant', () => {
    expect(
      parseDistributionArgs(['open', '--id', '42', '--start', '2026-09-14T00:00:00Z']),
    ).toEqual({
      ok: true,
      command: {
        kind: 'OPEN',
        distributionId: 42n,
        windowStart: Date.parse('2026-09-14T00:00:00Z'),
      },
    });
  });

  it('refuses a start with no timezone, which is midnight wherever the shell is', () => {
    expect(problemOf(['open', '--id', '42', '--start', '2026-09-14T00:00'])).toMatch(/timezone/);
  });

  it('accepts an explicit offset', () => {
    expect(
      parseDistributionArgs(['open', '--id', '1', '--start', '2026-09-14T07:00:00+07:00']),
    ).toMatchObject({ ok: true, command: { windowStart: Date.parse('2026-09-14T00:00:00Z') } });
  });
});

describe('taking a snapshot', () => {
  const args = [
    'snapshot',
    '--id',
    '42',
    '--pool-balance',
    '12400000000000000000',
    '--minimum-claim',
    '1000000000000000',
    '--out',
    'snapshot-42.json',
  ];

  it('reads amounts as exact base units, however large', () => {
    expect(parseDistributionArgs(args)).toEqual({
      ok: true,
      command: {
        kind: 'SNAPSHOT',
        distributionId: 42n,
        poolBalance: 12_400_000_000_000_000_000n,
        minimumClaim: 1_000_000_000_000_000n,
        out: 'snapshot-42.json',
      },
    });
  });

  it('refuses a decimal amount, which would be a unit mistake waiting to happen', () => {
    const decimal = [...args];
    decimal[4] = '12.4';
    expect(problemOf(decimal)).toMatch(/base units/);
  });

  it('refuses a snapshot missing any of its inputs', () => {
    expect(parseDistributionArgs(args.slice(0, 7))).toMatchObject({
      ok: false,
      problem: 'snapshot needs --out.',
    });
  });
});

describe('anything else', () => {
  it('refuses an unknown command, flag, repeat or missing value', () => {
    expect(parseDistributionArgs(['publish', '--id', '1'])).toMatchObject({ ok: false });
    expect(
      parseDistributionArgs([
        'open',
        '--id',
        '1',
        '--start',
        '2026-09-14T00:00:00Z',
        '--force',
        'yes',
      ]),
    ).toMatchObject({ ok: false, problem: '--force is not an option of open.' });
    expect(parseDistributionArgs(['open', '--id', '1', '--id', '2'])).toMatchObject({
      ok: false,
      problem: '--id was given twice.',
    });
    expect(parseDistributionArgs(['open', '--id', '--start'])).toMatchObject({
      ok: false,
      problem: '--id needs a value.',
    });
  });

  it('refuses an id that is not a non-negative integer', () => {
    expect(
      parseDistributionArgs(['open', '--id', '-1', '--start', '2026-09-14T00:00:00Z']),
    ).toMatchObject({ ok: false, problem: '--id must be a non-negative integer.' });
  });
});
