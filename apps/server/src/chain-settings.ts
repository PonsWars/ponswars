import { robinhoodChainNetwork } from '@ponswars/shared-types';
import { DistributionError } from '@ponswars/store-postgres';

/**
 * What the rewards jobs read from the environment about the chain (§16, §17).
 *
 * The operator command and the worker both need the same three — an endpoint,
 * the chain it must be, and the distributor — and each then needs one more:
 * the command a publisher key, the worker the minimum claim. They had a copy
 * of the shared part each, with the same three messages written out twice.
 *
 * Read from `process.env` rather than through `@ponswars/config`, which is
 * deliberate and not an oversight: these are operator steps, run by hand in a
 * shell, and requiring a whole server configuration to snapshot a window would
 * block a step on settings nobody has decided yet (`migrate.js` says the same).
 *
 * Everything here refuses rather than defaults. A wrong endpoint reads another
 * chain's distributor; a wrong address reads nothing; a minimum claim invented
 * here would be a product decision made by a job (§16.7, §102).
 */

export interface ChainSettings {
  readonly url: string;
  readonly chainId: number;
  readonly distributor: `0x${string}`;
}

/** The endpoint, the chain and the distributor, or a refusal naming which is wrong. */
export function chainSettings(env: NodeJS.ProcessEnv = process.env): ChainSettings {
  const url = env['RPC_URL'] ?? '';
  const chainId = Number(env['CHAIN_ID']);
  const distributor = env['REWARDS_DISTRIBUTOR_ADDRESS'] ?? '';
  if (!/^(https?|wss?):\/\//.test(url)) {
    throw new DistributionError('RPC_URL must be a Robinhood Chain JSON-RPC endpoint.');
  }
  if (robinhoodChainNetwork(chainId) === null) {
    throw new DistributionError('CHAIN_ID must be 4663 (Robinhood Chain) or 46630 (Testnet).');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(distributor)) {
    throw new DistributionError('REWARDS_DISTRIBUTOR_ADDRESS must be the distributor address.');
  }
  return { url, chainId, distributor: distributor.toLowerCase() as `0x${string}` };
}

/**
 * The key that signs a publication, or `null` for a publisher that is a
 * multisig (§20).
 *
 * Absent is not an error: without it the job prints the transaction for the
 * Safe to propose, which is how §20 expects a production deployment to publish.
 * The key is never echoed back — not in a refusal, not anywhere.
 */
export function publisherKey(env: NodeJS.ProcessEnv = process.env): `0x${string}` | null {
  const key = env['DISTRIBUTION_PUBLISHER_KEY'];
  if (key === undefined || key === '') {
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DistributionError('DISTRIBUTION_PUBLISHER_KEY must be a 32-byte private key.');
  }
  return key.toLowerCase() as `0x${string}`;
}

/**
 * The minimum claim, in base units (§16.7).
 *
 * `BASELINE` in the registry, so a job records the one it was given into every
 * snapshot and refuses to run without it rather than choosing one.
 */
export function minimumClaim(env: NodeJS.ProcessEnv = process.env): bigint {
  const minimum = env['REWARDS_MINIMUM_CLAIM'] ?? '';
  if (!/^(0|[1-9][0-9]*)$/.test(minimum)) {
    throw new DistributionError(
      'REWARDS_MINIMUM_CLAIM must be the minimum claim in base units (§16.7). ' +
        'It is an OPEN decision; this job records it in every snapshot rather than inventing one.',
    );
  }
  return BigInt(minimum);
}
