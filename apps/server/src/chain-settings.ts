import { PARAMETERS, type ParameterName, type ParseResult } from '@ponswars/config';
import {
  parseDecimalToBaseUnits,
  robinhoodChainNetwork,
  tokenDecimals,
} from '@ponswars/shared-types';
import { DistributionError } from '@ponswars/store-postgres';

/**
 * What the rewards jobs read from the environment about the chain (§16, §17).
 *
 * The operator command and the worker both need the same three — an endpoint,
 * the chain it must be, and the distributor — and each then needs one more:
 * the command a publisher key, the worker the minimum claim. They had a copy
 * of the shared part each, with the same three messages written out twice.
 *
 * Read from `process.env` a variable at a time rather than through
 * `loadConfig`, which is deliberate and not an oversight: these are operator
 * steps, run by hand in a shell, and requiring a whole server configuration to
 * snapshot a window would block a step on settings nobody has decided yet
 * (`migrate.js` says the same). Where a variable is also the server's, it is
 * parsed by the server's own function from the parameter table, so the two
 * cannot accept different things under one name.
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

/** One parameter, read the way the server's configuration reads it. */
function required<T>(
  env: NodeJS.ProcessEnv,
  name: ParameterName,
  parse: (raw: string) => ParseResult<T>,
): T {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    throw new DistributionError(`${name} is required and was not set.`);
  }
  const parsed = parse(raw);
  if (!parsed.ok) {
    throw new DistributionError(`${name}: ${parsed.error}.`);
  }
  return parsed.value;
}

export interface SpyToken {
  readonly address: `0x${string}`;
  /** As configured — check it against the chain before trusting it. */
  readonly decimals: number;
}

/**
 * The SPY token the pool is paid in, as the server's configuration names it.
 *
 * The same two variables, parsed by the same functions, so the worker and the
 * server cannot disagree about which token or how many decimals. The decimals
 * are the configured ones; `assertTokenDecimals` checks them against the chain
 * before a job converts anything with them.
 */
export function spyToken(env: NodeJS.ProcessEnv = process.env): SpyToken {
  const address = required(env, 'SPY_TOKEN_ADDRESS', PARAMETERS.SPY_TOKEN_ADDRESS.parse);
  return {
    address: address.toLowerCase() as `0x${string}`,
    decimals: required(env, 'SPY_TOKEN_DECIMALS', PARAMETERS.SPY_TOKEN_DECIMALS.parse),
  };
}

/**
 * The minimum claim, in base units (§16.7).
 *
 * Read from `MIN_CLAIM_THRESHOLD_SPY`, the one place a deployment states it
 * (ADR 0002), as a decimal SPY amount converted with SPY's decimals. There
 * used to be a second variable here in base units, which nothing kept in step
 * with the first: a deployment could state `0.001` where an operator reads it
 * and pay by a different number set somewhere else.
 *
 * `BASELINE` in the registry, so a job records the one it was given into every
 * snapshot and refuses to run without it rather than choosing one.
 */
export function minimumClaim(env: NodeJS.ProcessEnv = process.env): bigint {
  const decimal = required(
    env,
    'MIN_CLAIM_THRESHOLD_SPY',
    PARAMETERS.MIN_CLAIM_THRESHOLD_SPY.parse,
  );
  const { decimals } = spyToken(env);
  try {
    return parseDecimalToBaseUnits(decimal, tokenDecimals(decimals));
  } catch {
    // The one way a well-formed amount fails: more places than SPY has. Refused
    // rather than rounded, because rounding would be choosing the threshold.
    throw new DistributionError(
      `MIN_CLAIM_THRESHOLD_SPY ${decimal} has more decimal places than SPY's ${String(decimals)}.`,
    );
  }
}
