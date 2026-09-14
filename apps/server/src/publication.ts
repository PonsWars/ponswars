import type { DistributorContract } from '@ponswars/chain';
import { baseUnits } from '@ponswars/shared-types';
import {
  DistributionError,
  type CalculatedDistribution,
  type PostgresDistributionStore,
} from '@ponswars/store-postgres';

/**
 * Putting a calculated distribution's root on Robinhood Chain (§17).
 *
 * The step nothing can undo — a published root is immutable and the SPY it
 * commits leaves the treasury's reach — so every check that can be made first
 * is made first, and each refusal says what to do instead:
 *
 * 1. The window is calculated, has a root, and the root is the one the operator
 *    verified (`--expect-root`, from `tools/verify-distribution.mjs`).
 * 2. If the contract already holds a root for this id, it must be this root;
 *    it is then recorded rather than published again — a publication that
 *    landed before the database heard about it.
 * 3. Otherwise the publisher key holds `DISTRIBUTION_PUBLISHER_ROLE`, and the
 *    distributor holds enough uncommitted SPY to pay the whole root. A root
 *    published against an unfunded distributor is one whose claims revert.
 *
 * Only then is the transaction sent, and the window is recorded from what the
 * contract reads back, not from what was sent.
 */

export type PublicationOutcome =
  | { readonly kind: 'PUBLISHED'; readonly distribution: CalculatedDistribution }
  | { readonly kind: 'RECORDED'; readonly distribution: CalculatedDistribution }
  | { readonly kind: 'ALREADY_RECORDED'; readonly distribution: CalculatedDistribution };

export async function publishDistribution(input: {
  readonly store: Pick<PostgresDistributionStore, 'calculated' | 'recordPublication'>;
  readonly contract: DistributorContract;
  /** The publisher's address, or `null` to only record a root someone else published. */
  readonly publisher: `0x${string}` | null;
  readonly distributionId: bigint;
  readonly expectRoot: `0x${string}`;
}): Promise<PublicationOutcome> {
  const { store, contract, publisher, distributionId } = input;
  const id = distributionId.toString();

  const calculated = await store.calculated(distributionId);
  if (calculated === null) {
    throw new DistributionError(`Distribution ${id} has not been calculated. Calculate it first.`);
  }
  if (calculated.state !== 'CALCULATED') {
    return { kind: 'ALREADY_RECORDED', distribution: calculated };
  }
  if (calculated.root === null) {
    throw new DistributionError(
      `Distribution ${id} has no wallet above the minimum claim, so there is no root to publish. Its pool carries forward.`,
    );
  }
  if (input.expectRoot.toLowerCase() !== calculated.root) {
    throw new DistributionError(
      `Distribution ${id} was calculated with root ${calculated.root}, not the expected ${input.expectRoot}. Verify again before publishing.`,
    );
  }

  const onChain = await contract.distribution(distributionId);
  if (onChain !== null) {
    if (onChain.root.toLowerCase() !== calculated.root || onChain.total !== calculated.total) {
      throw new DistributionError(
        `Distribution ${id} is already on chain with root ${onChain.root} and total ${onChain.total.toString()}, which is not what was calculated. ` +
          'The id is spent; this needs an incident, not a retry.',
      );
    }
    const tx = await contract.findPublication(distributionId);
    if (tx === null) {
      throw new DistributionError(
        `Distribution ${id} is on chain, but its publication transaction was not found. Record it with its transaction hash by hand.`,
      );
    }
    const distribution = await store.recordPublication({
      distributionId,
      onChainRoot: onChain.root,
      onChainTotal: baseUnits(onChain.total),
      publicationTx: tx,
    });
    return { kind: 'RECORDED', distribution };
  }

  if (publisher === null) {
    throw new DistributionError(
      `Distribution ${id} is not on chain yet. Publish root ${calculated.root} with total ${calculated.total.toString()} ` +
        'from the publisher (a multisig proposes publishDistribution), then run this again to record it.',
    );
  }
  if (!(await contract.hasPublisherRole(publisher))) {
    throw new DistributionError(
      `${publisher} does not hold DISTRIBUTION_PUBLISHER_ROLE on the distributor. Nothing was sent.`,
    );
  }
  const uncommitted = await contract.uncommittedBalance();
  if (uncommitted < calculated.total) {
    throw new DistributionError(
      `The distributor holds ${uncommitted.toString()} uncommitted, but root ${calculated.root} commits ${calculated.total.toString()}. ` +
        'Fund it first: a root the distributor cannot pay is one whose claims revert. Nothing was sent.',
    );
  }

  const tx = await contract.publish(distributionId, calculated.root, calculated.total);
  const landed = await contract.distribution(distributionId);
  if (landed === null) {
    throw new DistributionError(
      `Publication ${tx} landed, but distribution ${id} reads back empty. Check the chain before retrying.`,
    );
  }
  const distribution = await store.recordPublication({
    distributionId,
    onChainRoot: landed.root,
    onChainTotal: baseUnits(landed.total),
    publicationTx: tx,
  });
  return { kind: 'PUBLISHED', distribution };
}
