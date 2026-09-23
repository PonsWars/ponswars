import { baseUnits, walletAddress } from '@ponswars/shared-types';
import type { DistributionSnapshot } from '@ponswars/store-postgres';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSnapshot, type SnapshotStore } from './snapshot-file.js';

/**
 * Writing a window's snapshot (§16.3).
 *
 * The property under test is an order: the file is claimed before the snapshot
 * is taken, because a snapshot commits once and standings that reached no disk
 * cannot be recovered by taking it again.
 */

const STANDINGS = [
  { wallet: walletAddress('0x1111111111111111111111111111111111111111'), windowWarPoints: 120 },
  { wallet: walletAddress('0x2222222222222222222222222222222222222222'), windowWarPoints: 75 },
];

function taken(distributionId: bigint): DistributionSnapshot {
  return {
    distributionId,
    poolBalance: baseUnits(4_200_000_000n),
    standings: STANDINGS,
  };
}

/** A store that answers as asked, and says whether it was asked at all. */
function store(answer: (id: bigint) => DistributionSnapshot | Error): {
  port: SnapshotStore;
  calls: bigint[];
} {
  const calls: bigint[] = [];
  return {
    calls,
    port: {
      snapshot: ({ distributionId }) => {
        calls.push(distributionId);
        const result = answer(distributionId);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ponswars-snapshot-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('a snapshot that is taken', () => {
  it('writes the standings, the pool and the minimum the window was taken under', async () => {
    const path = join(directory, 'snapshot-42.json');
    const db = store(taken);

    await writeSnapshot({
      store: db.port,
      distributionId: 42n,
      poolBalance: baseUnits(4_200_000_000n),
      minimumClaim: 1_000_000n,
      path,
    });

    const file: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(file).toEqual({
      distributionId: '42',
      poolBalance: '4200000000',
      // §16.7 leaves the threshold open, so the file records the one the
      // snapshot was taken under rather than whatever is configured later.
      minimumClaim: '1000000',
      standings: STANDINGS,
    });
  });
});

describe('a snapshot that is refused', () => {
  it('leaves no file behind, so the next attempt can still take it', async () => {
    // The failure this exists for: a transient database error. The window has
    // no snapshot, and a file left under its name would refuse every later
    // attempt — a window late for as long as the worker runs.
    const path = join(directory, 'snapshot-42.json');
    const db = store(() => new Error('connection terminated'));

    await expect(
      writeSnapshot({
        store: db.port,
        distributionId: 42n,
        poolBalance: baseUnits(1n),
        minimumClaim: 1n,
        path,
      }),
    ).rejects.toThrow('connection terminated');

    expect(existsSync(path)).toBe(false);

    // And the name is free: the same window snapshots on the next pass.
    const second = store(taken);
    await writeSnapshot({
      store: second.port,
      distributionId: 42n,
      poolBalance: baseUnits(4_200_000_000n),
      minimumClaim: 1n,
      path,
    });
    expect(existsSync(path)).toBe(true);
  });
});

describe('a name that is already taken', () => {
  it('refuses before the snapshot is taken, not after', async () => {
    // Two files under one name is how the wrong one gets verified; and a
    // snapshot taken here would commit against a file nobody can trust.
    const path = join(directory, 'snapshot-42.json');
    await writeFile(path, 'an earlier snapshot\n');
    const db = store(taken);

    await expect(
      writeSnapshot({
        store: db.port,
        distributionId: 42n,
        poolBalance: baseUnits(1n),
        minimumClaim: 1n,
        path,
      }),
    ).rejects.toThrow();

    expect(db.calls).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('an earlier snapshot\n');
  });
});
