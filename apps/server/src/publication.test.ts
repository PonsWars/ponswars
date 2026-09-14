import type { DistributorContract, OnChainDistribution } from '@ponswars/chain';
import { baseUnits } from '@ponswars/shared-types';
import type { CalculatedDistribution } from '@ponswars/store-postgres';
import { describe, expect, it } from 'vitest';
import { publishDistribution } from './publication.js';

const ROOT = `0x${'ab'.repeat(32)}` as const;
const TX = `0x${'cd'.repeat(32)}` as const;
const PUBLISHER = `0x${'1'.repeat(40)}` as const;

const CALCULATED: CalculatedDistribution = {
  distributionId: 42n,
  state: 'CALCULATED',
  root: ROOT,
  total: baseUnits(5_000n),
  claimable: 3,
  minimumClaim: baseUnits(10n),
  publicationTx: null,
};

function setup(
  options: {
    calculated?: CalculatedDistribution | null;
    onChain?: OnChainDistribution | null;
    uncommitted?: bigint;
    role?: boolean;
    found?: `0x${string}` | null;
  } = {},
) {
  const recorded: unknown[] = [];
  let onChain = options.onChain ?? null;
  const published: unknown[] = [];
  const store = {
    calculated: () =>
      Promise.resolve(options.calculated === undefined ? CALCULATED : options.calculated),
    recordPublication: (input: {
      distributionId: bigint;
      onChainRoot: `0x${string}`;
      onChainTotal: bigint;
      publicationTx: `0x${string}`;
    }) => {
      recorded.push(input);
      return Promise.resolve({ ...CALCULATED, state: 'PUBLISHED' as const, publicationTx: TX });
    },
  };
  const contract: DistributorContract = {
    distribution: () => Promise.resolve(onChain),
    uncommittedBalance: () => Promise.resolve(options.uncommitted ?? 5_000n),
    hasClaimed: () => Promise.resolve(false),
    hasPublisherRole: () => Promise.resolve(options.role ?? true),
    publish: (distributionId, root, total) => {
      published.push({ distributionId, root, total });
      onChain = { root, total };
      return Promise.resolve(TX);
    },
    findPublication: () => Promise.resolve(options.found === undefined ? TX : options.found),
  };
  return { store, contract, recorded, published };
}

const run = (
  fixture: ReturnType<typeof setup>,
  overrides: { publisher?: `0x${string}` | null; expectRoot?: `0x${string}` } = {},
) =>
  publishDistribution({
    store: fixture.store,
    contract: fixture.contract,
    publisher: overrides.publisher === undefined ? PUBLISHER : overrides.publisher,
    distributionId: 42n,
    expectRoot: overrides.expectRoot ?? ROOT,
  });

describe('publishing a distribution (§17)', () => {
  it('publishes the calculated root and records what the contract reads back', async () => {
    const fixture = setup();

    const outcome = await run(fixture);

    expect(outcome.kind).toBe('PUBLISHED');
    expect(fixture.published).toEqual([{ distributionId: 42n, root: ROOT, total: 5_000n }]);
    expect(fixture.recorded).toEqual([
      { distributionId: 42n, onChainRoot: ROOT, onChainTotal: 5_000n, publicationTx: TX },
    ]);
  });

  it('refuses a root that is not the one the operator verified', async () => {
    const fixture = setup();

    await expect(run(fixture, { expectRoot: `0x${'11'.repeat(32)}` })).rejects.toThrow(
      /Verify again before publishing/,
    );
    expect(fixture.published).toEqual([]);
  });

  it('refuses to publish against a distributor that cannot pay the root', async () => {
    const fixture = setup({ uncommitted: 4_999n });

    await expect(run(fixture)).rejects.toThrow(/Fund it first/);
    expect(fixture.published).toEqual([]);
  });

  it('refuses a key without the publisher role', async () => {
    const fixture = setup({ role: false });

    await expect(run(fixture)).rejects.toThrow(/does not hold DISTRIBUTION_PUBLISHER_ROLE/);
    expect(fixture.published).toEqual([]);
  });

  it('records a root already on chain instead of publishing it twice', async () => {
    const fixture = setup({ onChain: { root: ROOT, total: 5_000n } });

    const outcome = await run(fixture, { publisher: null });

    expect(outcome.kind).toBe('RECORDED');
    expect(fixture.published).toEqual([]);
    expect(fixture.recorded).toHaveLength(1);
  });

  it('refuses when the id is already on chain with another root', async () => {
    const fixture = setup({ onChain: { root: `0x${'99'.repeat(32)}`, total: 5_000n } });

    await expect(run(fixture)).rejects.toThrow(/The id is spent/);
    expect(fixture.recorded).toEqual([]);
  });

  it('says how to publish from a multisig when no key is given', async () => {
    await expect(run(setup(), { publisher: null })).rejects.toThrow(/multisig proposes/);
  });

  it('has nothing to publish for a window with no root, and is idempotent once recorded', async () => {
    await expect(run(setup({ calculated: { ...CALCULATED, root: null } }))).rejects.toThrow(
      /no root to publish/,
    );
    await expect(run(setup({ calculated: null }))).rejects.toThrow(/Calculate it first/);
    const done = setup({ calculated: { ...CALCULATED, state: 'PUBLISHED', publicationTx: TX } });
    expect((await run(done)).kind).toBe('ALREADY_RECORDED');
    expect(done.published).toEqual([]);
  });
});
