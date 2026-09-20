import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DISTRIBUTOR_ABI } from './rpc-distributor.js';
import { VAULT_ABI } from './rpc-vault.js';

/**
 * The hand-written ABIs, against the contracts they call (§19).
 *
 * This client carries its own slice of each ABI rather than importing the
 * compiled one, which keeps the build free of Foundry. The cost is that the
 * two can drift: a function renamed or an argument added on one side is a call
 * that fails at runtime, and an error the contract throws that this side does
 * not declare is a revert nobody can put a name to — which is how the
 * distributor's funding guard would have reached an operator.
 *
 * Against `contracts/out`, which `forge build` writes and the verify script
 * runs before tests. Where it has not been built, this says so rather than
 * passing on nothing, the same way the auth pool's tests do for `dist/`.
 */

interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly { readonly type: string }[];
  readonly outputs?: readonly { readonly type: string }[];
}

function compiled(contract: string): readonly AbiEntry[] | null {
  const url = new URL(`../../../contracts/out/${contract}.sol/${contract}.json`, import.meta.url);
  if (!existsSync(url)) {
    return null;
  }
  const artifact = JSON.parse(readFileSync(url, 'utf8')) as { readonly abi: readonly AbiEntry[] };
  return artifact.abi;
}

/** An entry reduced to what decides whether a call or a decode lines up. */
function signature(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? []).map((input) => input.type).join(',');
  const outputs = (entry.outputs ?? []).map((output) => output.type).join(',');
  return `${entry.type} ${entry.name ?? ''}(${inputs})${entry.type === 'function' ? ` -> (${outputs})` : ''}`;
}

const CONTRACTS = [
  { contract: 'RewardsDistributor', abi: DISTRIBUTOR_ABI as readonly AbiEntry[] },
  { contract: 'SecretStockVault', abi: VAULT_ABI as readonly AbiEntry[] },
] as const;

for (const { contract, abi } of CONTRACTS) {
  const real = compiled(contract);

  describe.skipIf(real === null)(`${contract}'s ABI as this client holds it`, () => {
    it('has nothing the compiled contract does not', () => {
      const known = new Set((real ?? []).map(signature));
      for (const entry of abi) {
        expect(known, `${contract}: ${signature(entry)}`).toContain(signature(entry));
      }
    });

    it('declares every error the contract can throw from what this client calls', () => {
      // The errors are how a refusal reaches an operator in words. One missing
      // here is a revert this client reports as a bare failure.
      const declared = new Set(
        abi.filter((entry) => entry.type === 'error').map((entry) => entry.name),
      );
      const thrown = (real ?? [])
        .filter((entry) => entry.type === 'error')
        .map((entry) => entry.name);
      const expected: Readonly<Record<string, readonly string[]>> = {
        RewardsDistributor: ['DistributionAlreadyPublished', 'InsufficientUncommittedBalance'],
        SecretStockVault: ['AlreadyEntitled', 'InsufficientCoverage'],
      };
      for (const name of expected[contract] ?? []) {
        expect(thrown).toContain(name);
        expect(declared).toContain(name);
      }
    });
  });
}
